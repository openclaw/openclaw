// Lobster plugin module implements lobster taskflow behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  LobsterRunnerError,
  type LobsterEnvelope,
  type LobsterRunner,
  type LobsterRunnerParams,
} from "./lobster-runner.js";

export type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | {
      [key: string]: JsonLike;
    };

type RuntimeTasks = NonNullable<OpenClawPluginApi["runtime"]>["tasks"];
export type BoundTaskFlow = Pick<
  ReturnType<RuntimeTasks["async"]["managedFlows"]["bindSession"]>,
  "get" | "list" | "tryCreateManaged" | "resume" | "setWaiting" | "finish" | "fail"
> &
  Pick<ReturnType<RuntimeTasks["managedFlows"]["bindSession"]>, "cancel">;

type FlowRecord = NonNullable<Awaited<ReturnType<BoundTaskFlow["get"]>>>;
type MutationResult =
  | Awaited<ReturnType<BoundTaskFlow["setWaiting"]>>
  | Awaited<ReturnType<BoundTaskFlow["cancel"]>>;

type LobsterApprovalWaitState = {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
  approvalId?: string;
  cwd?: string;
};

type LobsterInputWaitState = {
  kind: "lobster_input";
  prompt: string;
  responseSchema: JsonLike;
  defaults?: JsonLike;
  subject?: JsonLike;
  resumeToken: string;
  cwd: string;
};

type LobsterWaitState = LobsterApprovalWaitState | LobsterInputWaitState;

type RunManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  config: OpenClawPluginApi["config"];
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams;
  controllerId: string;
  goal: string;
  stateJson?: JsonLike;
  currentStep?: string;
  waitingStep?: string;
};

type ResumeManagedLobsterFlowParams = {
  taskFlow: BoundTaskFlow;
  config: OpenClawPluginApi["config"];
  runner: LobsterRunner;
  runnerParams: LobsterRunnerParams & {
    action: "resume";
  };
  flowId: string;
  expectedRevision: number;
  currentStep?: string;
  waitingStep?: string;
};

export type ManagedLobsterFlowResult =
  | {
      ok: true;
      envelope: LobsterEnvelope;
      flow: FlowRecord;
      mutation: MutationResult;
    }
  | {
      ok: false;
      flow?: FlowRecord;
      mutation?: MutationResult;
      error: Error;
    };

function toJsonLike(value: unknown, seen = new WeakSet<object>()): JsonLike {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const jsonArray = value.map((item) => toJsonLike(item, seen));
    seen.delete(value);
    return jsonArray;
  }
  const jsonObject: Record<string, JsonLike> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
      continue;
    }
    jsonObject[key] = toJsonLike(entry, seen);
  }
  seen.delete(value);
  return jsonObject;
}

function buildWaitState(
  envelope: Extract<LobsterEnvelope, { ok: true }>,
  cwd: string,
): LobsterWaitState {
  if (envelope.status === "needs_input") {
    const input = envelope.requiresInput;
    if (!input?.resumeToken || input.responseSchema === undefined) {
      throw new Error("Lobster returned an incomplete input checkpoint");
    }
    return {
      kind: "lobster_input",
      prompt: input.prompt,
      // The dependency owns these JSON values. Preserve schema keys verbatim,
      // including own properties such as __proto__, rather than coercing them.
      // SAFETY: the pinned runtime supplies a JSON schema; cloning preserves its own keys.
      responseSchema: structuredClone(input.responseSchema) as JsonLike,
      ...(input.defaults !== undefined
        ? {
            // SAFETY: the pinned runtime's input defaults are JSON checkpoint data.
            defaults: structuredClone(input.defaults) as JsonLike,
          }
        : {}),
      ...(input.subject !== undefined
        ? {
            // SAFETY: the pinned runtime's input subject is JSON checkpoint data.
            subject: structuredClone(input.subject) as JsonLike,
          }
        : {}),
      resumeToken: input.resumeToken,
      cwd,
    };
  }
  const approval = envelope.requiresApproval;
  return {
    kind: "lobster_approval",
    prompt: approval ? approval.prompt : "",
    items: approval ? approval.items.map((item) => toJsonLike(item)) : [],
    ...(approval?.resumeToken ? { resumeToken: approval.resumeToken } : {}),
    ...(approval?.approvalId ? { approvalId: approval.approvalId } : {}),
    cwd,
  } satisfies LobsterApprovalWaitState;
}

function readWaitState(value: JsonLike | undefined): LobsterWaitState | undefined {
  if (!isRecord(value) || typeof value.prompt !== "string") {
    return undefined;
  }
  if (
    value.kind === "lobster_input" &&
    value.responseSchema !== undefined &&
    typeof value.resumeToken === "string" &&
    value.resumeToken.length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0
  ) {
    // SAFETY: required input fields are checked above; remaining values are already JsonLike.
    return value as LobsterInputWaitState;
  }
  if (
    value.kind === "lobster_approval" &&
    Array.isArray(value.items) &&
    (value.resumeToken === undefined || typeof value.resumeToken === "string") &&
    (value.approvalId === undefined || typeof value.approvalId === "string") &&
    (Boolean(value.resumeToken) || Boolean(value.approvalId)) &&
    (value.cwd === undefined || typeof value.cwd === "string")
  ) {
    // SAFETY: required approval fields are checked above; remaining values are already JsonLike.
    return value as LobsterApprovalWaitState;
  }
  return undefined;
}

/** Read through the existing owner-bound runtime; flow ids do not grant access. */
export async function inspectManagedLobsterFlows(
  taskFlow: BoundTaskFlow,
  flowId?: string,
  offset = 0,
) {
  if (flowId) {
    const flow = await taskFlow.get(flowId);
    if (!flow || flow.syncMode !== "managed" || !readWaitState(flow.waitJson)) {
      throw new Error("Saved Lobster checkpoint not found in this session");
    }
    // Arbitrary caller state is not needed to answer a saved question and can
    // dwarf it. Keep the checkpoint and its current revision discoverable.
    return {
      ok: true,
      flow: {
        flowId: flow.flowId,
        revision: flow.revision,
        status: flow.status,
        goal: flow.goal,
        currentStep: flow.currentStep,
        waitJson: flow.waitJson,
        cancelRequestedAt: flow.cancelRequestedAt,
        endedAt: flow.endedAt,
      },
    };
  }
  const pending = (await taskFlow.list())
    .filter(
      (flow) =>
        flow.syncMode === "managed" &&
        (flow.status === "waiting" || flow.status === "blocked") &&
        flow.cancelRequestedAt == null &&
        flow.endedAt == null &&
        readWaitState(flow.waitJson),
    )
    .toSorted((a, b) => a.createdAt - b.createdAt || a.flowId.localeCompare(b.flowId));
  const flows = pending.slice(offset, offset + 20).map((flow) => ({
    flowId: flow.flowId,
    revision: flow.revision,
    status: flow.status,
    goal: flow.goal.slice(0, 200),
    currentStep: flow.currentStep?.slice(0, 200),
  }));
  return {
    ok: true,
    flows,
    ...(offset + flows.length < pending.length ? { nextOffset: offset + flows.length } : {}),
  };
}

async function assertFlowClaim(taskFlow: BoundTaskFlow, flow: FlowRecord): Promise<void> {
  const current = await taskFlow.get(flow.flowId);
  if (
    !current ||
    current.revision !== flow.revision ||
    current.status !== flow.status ||
    current.cancelRequestedAt != null ||
    current.endedAt != null
  ) {
    throw new Error("TaskFlow execution claim is no longer active; inspect its current status");
  }
}

async function settleCancelledClaim(
  params: Pick<RunManagedLobsterFlowParams, "taskFlow" | "config">,
  flow: FlowRecord,
  error: Error,
): Promise<ManagedLobsterFlowResult | undefined> {
  const current = await params.taskFlow.get(flow.flowId);
  if (
    current?.syncMode === "managed" &&
    current.controllerId === flow.controllerId &&
    current.status === "running" &&
    current.endedAt == null &&
    current.cancelRequestedAt != null &&
    current.revision === flow.revision + 1
  ) {
    // Public managed mutations preserve cancellation intent; settle only the
    // immediate cancellation successor observed here and leave other updates alone.
    const mutation = await params.taskFlow.cancel({ flowId: flow.flowId, cfg: params.config });
    return { ok: false, flow: mutation.flow ?? current, mutation, error };
  }
  return undefined;
}

async function executeManagedLobsterFlow(
  params: Pick<
    RunManagedLobsterFlowParams,
    "taskFlow" | "config" | "runner" | "runnerParams" | "waitingStep"
  >,
  flow: FlowRecord,
  previousWait?: { wait: LobsterWaitState; currentStep?: string },
): Promise<ManagedLobsterFlowResult> {
  try {
    await assertFlowClaim(params.taskFlow, flow);
    const envelope = await params.runner.run({
      ...params.runnerParams,
      beforeExecute: () => assertFlowClaim(params.taskFlow, flow),
    });
    await assertFlowClaim(params.taskFlow, flow);
    if (envelope.ok && envelope.status === "cancelled") {
      try {
        const mutation = await params.taskFlow.cancel({ flowId: flow.flowId, cfg: params.config });
        return mutation.cancelled
          ? { ok: true, envelope, flow: { ...flow, ...mutation.flow }, mutation }
          : {
              ok: false,
              flow,
              mutation,
              error: new Error(`TaskFlow cancellation failed: ${mutation.reason ?? "unknown"}`),
            };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { ok: false, flow, error: err };
      }
    }
    const flowMutation = { flowId: flow.flowId, expectedRevision: flow.revision };
    if (!envelope.ok) {
      throw new LobsterRunnerError(envelope.error.message, envelope.error.type);
    }
    const mutation =
      envelope.status === "needs_approval" || envelope.status === "needs_input"
        ? await params.taskFlow.setWaiting({
            ...flowMutation,
            currentStep:
              params.waitingStep ??
              (envelope.status === "needs_input"
                ? "await_lobster_input"
                : "await_lobster_approval"),
            waitJson: buildWaitState(envelope, params.runnerParams.cwd),
          })
        : await params.taskFlow.finish(flowMutation);
    if (!mutation.applied) {
      // Cancellation may win after the last claim read. Settle that successor
      // through the same guarded error path as a rejected execution claim.
      throw new Error(
        `TaskFlow result could not be persisted: ${mutation.code}; do not replay the workflow`,
      );
    }
    return { ok: true, envelope, flow: mutation.flow, mutation };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const cancelled = await settleCancelledClaim(params, flow, err);
      if (cancelled) {
        return cancelled;
      }
      // Only restore saved input waits for rejected answers. Approval lookup and cancellation
      // parse errors are not answer validation; do not advertise those waits
      // again. The runner rejects malformed response tokens before dispatch.
      await assertFlowClaim(params.taskFlow, flow);
      const flowMutation = {
        flowId: flow.flowId,
        expectedRevision: flow.revision,
      };
      const mutation =
        previousWait?.wait.kind === "lobster_input" &&
        params.runnerParams.response !== undefined &&
        err instanceof LobsterRunnerError &&
        err.type === "parse_error"
          ? await params.taskFlow.setWaiting({
              ...flowMutation,
              currentStep: previousWait.currentStep,
              waitJson: previousWait.wait,
            })
          : await params.taskFlow.fail(flowMutation);
      if (!mutation.applied) {
        const cancelledMutation = await settleCancelledClaim(params, flow, err);
        if (cancelledMutation) {
          return cancelledMutation;
        }
      }
      return { ok: false, flow: mutation.applied ? mutation.flow : flow, mutation, error: err };
    } catch {
      // Cancellation may invalidate the recovery claim after its first read.
      // Make one final settlement attempt, preserving the original error if
      // the store or cancellation transport is unavailable.
      const cancelled = await settleCancelledClaim(params, flow, err).catch(() => undefined);
      return cancelled ?? { ok: false, flow, error: err };
    }
  }
}

export async function runManagedLobsterFlow(
  params: RunManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const createFlowParams = {
    controllerId: params.controllerId,
    goal: params.goal,
    status: "running" as const,
    currentStep: params.currentStep ?? "run_lobster",
    ...(params.stateJson !== undefined ? { stateJson: params.stateJson } : {}),
  };
  const flow = await params.taskFlow.tryCreateManaged(createFlowParams);
  if (!flow) {
    return { ok: false, error: new Error("TaskFlow persistence failed.") };
  }
  return await executeManagedLobsterFlow(params, flow);
}

export async function resumeManagedLobsterFlow(
  params: ResumeManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const flow = await params.taskFlow.get(params.flowId);
  const wait = flow?.syncMode === "managed" ? readWaitState(flow.waitJson) : undefined;
  if (
    !flow ||
    !wait ||
    (flow.status !== "waiting" && flow.status !== "blocked") ||
    flow.endedAt != null ||
    flow.cancelRequestedAt != null
  ) {
    return {
      ok: false,
      error: new Error("No pending Lobster checkpoint in this session; inspect the flow status"),
    };
  }
  // The read and revision claim are asynchronous. Never claim a newer revision
  // using checkpoint data read from an older one, even if the caller guessed it.
  if (flow.revision !== params.expectedRevision) {
    return {
      ok: false,
      error: new Error("TaskFlow resume failed: revision_conflict; inspect its current status"),
    };
  }
  const supplied = params.runnerParams;
  if (
    (supplied.token !== undefined && supplied.token.trim() !== wait.resumeToken) ||
    (supplied.approvalId !== undefined &&
      (wait.kind !== "lobster_approval" || supplied.approvalId.trim() !== wait.approvalId))
  ) {
    return {
      ok: false,
      error: new Error("Resume credential does not match the saved TaskFlow checkpoint"),
    };
  }
  const decisions =
    Number(supplied.response !== undefined) +
    Number(supplied.approve !== undefined) +
    Number(supplied.cancel === true);
  if (
    decisions !== 1 ||
    (supplied.cancel !== true &&
      (wait.kind === "lobster_input"
        ? supplied.response === undefined
        : supplied.approve === undefined))
  ) {
    return {
      ok: false,
      error: new Error(
        wait.kind === "lobster_input"
          ? "Input checkpoint requires responseJson or cancel:true, not approve"
          : "Approval checkpoint requires approve or cancel:true, not responseJson",
      ),
    };
  }
  const credential = wait.resumeToken
    ? { token: wait.resumeToken }
    : wait.kind === "lobster_approval"
      ? { approvalId: wait.approvalId }
      : {};
  const resumed = await params.taskFlow.resume({
    flowId: params.flowId,
    expectedRevision: params.expectedRevision,
    status: "running",
    currentStep: params.currentStep ?? "resume_lobster",
  });

  if (!resumed.applied) {
    return {
      ok: false,
      mutation: resumed,
      error: new Error(`TaskFlow resume failed: ${resumed.code}`),
    };
  }
  return await executeManagedLobsterFlow(
    {
      ...params,
      runnerParams: {
        action: "resume",
        ...(supplied.signal ? { signal: supplied.signal } : {}),
        ...credential,
        ...(supplied.approve !== undefined ? { approve: supplied.approve } : {}),
        ...(supplied.response !== undefined ? { response: supplied.response } : {}),
        ...(supplied.cancel === true ? { cancel: true } : {}),
        cwd: wait.cwd ?? supplied.cwd,
        timeoutMs: supplied.timeoutMs,
        maxStdoutBytes: supplied.maxStdoutBytes,
      },
    },
    resumed.flow,
    { wait, currentStep: flow.currentStep },
  );
}
