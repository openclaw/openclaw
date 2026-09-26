// Lobster plugin module implements lobster taskflow behavior.
import type { OpenClawPluginApi } from "../runtime-api.js";
import type { LobsterEnvelope, LobsterRunner, LobsterRunnerParams } from "./lobster-runner.js";

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
export type BoundTaskFlow = Required<
  Pick<
    ReturnType<RuntimeTasks["async"]["managedFlows"]["bindSession"]>,
    "get" | "tryCreateManaged" | "resume" | "setWaiting" | "finish" | "fail" | "cancel"
  >
>;

type FlowRecord = NonNullable<Awaited<ReturnType<BoundTaskFlow["tryCreateManaged"]>>>;
type MutationResult =
  | Awaited<ReturnType<BoundTaskFlow["setWaiting"]>>
  | Awaited<ReturnType<BoundTaskFlow["cancel"]>>;

type LobsterApprovalWaitState = {
  kind: "lobster_approval";
  prompt: string;
  items: JsonLike[];
  resumeToken?: string;
  approvalId?: string;
};

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
    approve: boolean;
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

function buildApprovalWaitState(envelope: Extract<LobsterEnvelope, { ok: true }>): JsonLike {
  const approval = envelope.requiresApproval;
  return {
    kind: "lobster_approval",
    prompt: approval ? approval.prompt : "",
    items: approval ? approval.items.map((item) => toJsonLike(item)) : [],
    ...(approval?.resumeToken ? { resumeToken: approval.resumeToken } : {}),
    ...(approval?.approvalId ? { approvalId: approval.approvalId } : {}),
  } satisfies LobsterApprovalWaitState;
}

async function executeManagedLobsterFlow(
  params: Pick<
    RunManagedLobsterFlowParams,
    "taskFlow" | "config" | "runner" | "runnerParams" | "waitingStep"
  >,
  flow: FlowRecord,
): Promise<ManagedLobsterFlowResult> {
  try {
    const envelope = await params.runner.run(params.runnerParams);
    if (envelope.ok && envelope.status === "cancelled") {
      try {
        const mutation = await params.taskFlow.cancel({
          flowId: flow.flowId,
          cfg: params.config,
          expectedFlow: flow,
        });
        return mutation.cancelled
          ? { ok: true, envelope, flow, mutation }
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
      const mutation = await params.taskFlow.fail(flowMutation);
      return { ok: false, flow, mutation, error: new Error(envelope.error.message) };
    }
    const mutation =
      envelope.status === "needs_approval"
        ? await params.taskFlow.setWaiting({
            ...flowMutation,
            currentStep: params.waitingStep ?? "await_lobster_approval",
            waitJson: buildApprovalWaitState(envelope),
          })
        : await params.taskFlow.finish(flowMutation);
    return { ok: true, envelope, flow, mutation };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      const mutation = await params.taskFlow.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
      });
      return { ok: false, flow, mutation, error: err };
    } catch {
      return { ok: false, flow, error: err };
    }
  }
}

export async function runManagedLobsterFlow(
  params: RunManagedLobsterFlowParams,
): Promise<ManagedLobsterFlowResult> {
  const createFlowParams = {
    controllerId: params.controllerId,
    goal: params.goal,
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
  const saved = await params.taskFlow.get(params.flowId);
  if (
    !saved ||
    saved.syncMode !== "managed" ||
    saved.endedAt !== undefined ||
    saved.cancelRequestedAt !== undefined ||
    (saved.status !== "waiting" && saved.status !== "blocked")
  ) {
    return { ok: false, error: new Error("TaskFlow has no resumable Lobster checkpoint.") };
  }
  const wait = saved.waitJson;
  if (
    !wait ||
    typeof wait !== "object" ||
    Array.isArray(wait) ||
    wait.kind !== "lobster_approval"
  ) {
    return { ok: false, error: new Error("TaskFlow is not waiting for Lobster approval.") };
  }
  const token = typeof wait.resumeToken === "string" ? wait.resumeToken : undefined;
  const approvalId = typeof wait.approvalId === "string" ? wait.approvalId : undefined;
  if (
    (!token && !approvalId) ||
    (params.runnerParams.token !== undefined && params.runnerParams.token.trim() !== token) ||
    (params.runnerParams.approvalId !== undefined &&
      params.runnerParams.approvalId.trim() !== approvalId)
  ) {
    return {
      ok: false,
      error: new Error("Lobster checkpoint does not match the selected TaskFlow."),
    };
  }
  const runnerParams = {
    ...params.runnerParams,
    ...(params.runnerParams.token || params.runnerParams.approvalId
      ? {}
      : token
        ? { token }
        : { approvalId }),
  };
  // Revision admission binds the saved checkpoint to the state we resume.
  if (saved.revision !== params.expectedRevision) {
    return { ok: false, error: new Error("TaskFlow resume failed: revision_conflict") };
  }
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
  return await executeManagedLobsterFlow({ ...params, runnerParams }, resumed.flow);
}
