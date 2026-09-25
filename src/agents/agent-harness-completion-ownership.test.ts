import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  registerAgentRunContext,
  clearAgentRunContext,
  retainQueuedAgentRunContext,
  getAgentRunLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "../plugin-sdk/agent-harness-task-runtime.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
} from "../tasks/agent-harness-completion-recovery.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { getTaskById } from "../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { buildCurrentRunRestartRecoveryClaim } from "./agent-command-restart-recovery.js";
import { reconcileHarnessCompletionDelivery } from "./agent-harness-completion-delivery.js";
import { deliverSubagentAnnouncement } from "./subagents/announce/subagent-announce-delivery.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
vi.mock("./subagents/announce/subagent-announce-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagents/announce/subagent-announce-delivery.js")>()),
  deliverSubagentAnnouncement: vi.fn(async () => ({ delivered: true, path: "steered" })),
}));
const key = "agent:main:main",
  child = "review4:child",
  source = "announce:review4:parent:child:succeeded";
async function setup(
  state: OpenClawTestState,
  terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded",
) {
  resetTaskRegistryForTests({ persist: false });
  const scope = createAgentHarnessTaskRuntimeScope({ requesterSessionKey: key });
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "review4-native",
    scope,
    runIdPrefix: "review4:",
  });
  const create = (text: string) => {
    const task = runtime.createRunningTaskRun({
      runId: child,
      sourceId: child,
      task: text,
      requesterAgentId: "main",
      notifyPolicy: "silent",
    });
    runtime.finalizeTaskRunByRunId({
      runId: child,
      status: terminalStatus,
      endedAt: Date.now(),
      terminalSummary: "result",
    });
    runtime.setDetachedTaskDeliveryStatusByRunId({ runId: child, deliveryStatus: "pending" });
    return task;
  };
  const task = create("first record");
  const target = {
    agentId: "main",
    sessionKey: key,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  const entry = {
    sessionId: "physical-1",
    lifecycleRevision: "revision-1",
    status: "running" as const,
    updatedAt: Date.now(),
  };
  await replaceSessionEntry(target, entry);
  return { scope, runtime, create, task, target, entry };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deliverSubagentAnnouncement)
    .mockReset()
    .mockResolvedValue({ delivered: true, path: "steered" });
});
describe("live harness cancellation reporting", () => {
  it.each(
    (["succeeded", "failed", "cancelled"] as const).flatMap((stored) =>
      (["succeeded", "failed", "cancelled"] as const).map(
        (reported) => [stored, reported, stored === reported] as const,
      ),
    ),
  )("checks stored %s against reported %s", async (stored, reported, allowed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { scope, task, entry } = await setup(state, stored);
      expect(getTaskById(task.taskId)?.status).toBe(stored);
      const claim = captureHarnessCompletionRecovery({
        agentId: "main",
        sessionKey: key,
        entry,
        runId: source,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "agent_harness_task",
          sourceChannel: "internal",
          sourceSessionKey: child,
        },
      });
      expect(Boolean(claim)).toBe(stored !== "cancelled");
      const result = await deliverAgentHarnessTaskCompletion({
        scope,
        childSessionKey: child,
        childSessionId: "child",
        announceId: `review11:parent:child:${reported}`,
        status: reported,
        result: reported === "cancelled" ? "Task was cancelled" : "Task result",
      });
      expect(result.delivered).toBe(allowed);
      expect(deliverSubagentAnnouncement).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(
          vi
            .mocked(deliverSubagentAnnouncement)
            .mock.calls[0]?.[0].isSourceSessionEffectsAllowed?.(),
        ).toBe(true);
      }
      expect(getTaskById(task.taskId)).toMatchObject({ status: stored, deliveryStatus: "pending" });
    });
  });
});

describe("review4 exact task ownership", () => {
  it.each(["requester", "task"] as const)(
    "rechecks retained %s identity after an asynchronous delivery boundary",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { task, target, entry } = await setup(state);
        const context = createContext();
        const resolver = () => context;
        context.resolveGatewayContext = resolver;
        const scope = createAgentHarnessTaskRuntimeScope({
          requesterSessionKey: key,
          gatewayContextResolver: resolver,
        });
        const custody = (await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: key,
            gatewayContextResolver: resolver,
            operationalRunInstance:
              createTestAdmittedRunContext("parent-run").operationalRunInstance,
            receiptAuthority: () => true,
          },
          () => captureAgentHarnessCompletionCustody(scope),
        ))!;
        vi.mocked(deliverSubagentAnnouncement).mockImplementationOnce(async (params) => {
          expect(params.isSourceSessionEffectsAllowed?.()).toBe(true);
          await Promise.resolve();
          if (changed === "requester") {
            await replaceSessionEntry(target, { ...entry, sessionId: "replacement-session" });
          } else {
            updateTask(task.taskId, { createdAt: task.createdAt - 1 });
            expect(getTaskById(task.taskId)?.createdAt).toBe(task.createdAt - 1);
          }
          expect(params.isSourceSessionEffectsAllowed?.()).toBe(false);
          return { delivered: false, path: "none" };
        });
        try {
          const result = await deliverAgentHarnessTaskCompletion({
            scope,
            completionCustody: custody,
            childSessionKey: child,
            childSessionId: "child",
            announceId: source.slice("announce:".length),
            status: "succeeded",
            result: "result",
          });
          expect(result.delivered).toBe(false);
        } finally {
          custody.release();
        }
      });
    },
  );

  it.each(["single", "duplicate", "late-duplicate"])(
    "uses real task creation for %s ownership",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { scope, runtime, create, task } = await setup(state);
        if (kind === "duplicate") {
          expect(create("second record").taskId).not.toBe(task.taskId);
        }
        expect(runtime.listTaskRecords()).toHaveLength(kind === "duplicate" ? 2 : 1);
        if (kind === "late-duplicate") {
          vi.mocked(deliverSubagentAnnouncement).mockImplementationOnce(async (params) => {
            expect(params.isSourceSessionEffectsAllowed?.()).toBe(true);
            await Promise.resolve();
            expect(create("second record").taskId).not.toBe(task.taskId);
            expect(params.isSourceSessionEffectsAllowed?.()).toBe(false);
            return { delivered: false, path: "none" };
          });
        }
        const result = await deliverAgentHarnessTaskCompletion({
          scope,
          childSessionKey: child,
          childSessionId: "child",
          announceId: source.slice("announce:".length),
          status: "succeeded",
          result: "result",
        });
        if (kind === "duplicate") {
          expect(result).toMatchObject({ delivered: false, recoveryBlocked: true });
          expect(deliverSubagentAnnouncement).not.toHaveBeenCalled();
        } else {
          expect(result.delivered).toBe(kind === "single");
        }
        expect(getTaskById(task.taskId)?.deliveryStatus).toBe("pending");
      });
    },
  );
  it.each(["projection-only", "queued", "released-queue"])(
    "distinguishes %s from execution custody",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry, target, task } = await setup(state);
        const claim = captureHarnessCompletionRecovery({
          agentId: "main",
          sessionKey: key,
          entry,
          runId: source,
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
            sourceChannel: "internal",
            sourceSessionKey: child,
          },
        });
        expect(claim).toBeDefined();
        await replaceSessionEntry(target, {
          ...entry,
          ...buildCurrentRunRestartRecoveryClaim({
            entry,
            runId: source,
            sourceRunId: source,
            sourceIngress: "internal",
            sourceReplyDeliveryMode: "automatic",
            deliveryContext: { channel: "discord", to: "channel:123" },
            harnessCompletion: claim,
          }),
        });
        registerAgentRunContext(source, {
          sessionKey: key,
          sessionId: entry.sessionId,
          agentId: "main",
          projectSessionActive: kind !== "queued",
        });
        const release =
          kind === "projection-only"
            ? undefined
            : retainQueuedAgentRunContext(source, getAgentRunLifecycleGeneration());
        try {
          if (kind === "released-queue") {
            release?.("abandoned");
          }
          expect(
            reconcileHarnessCompletionDelivery({
              ...target,
              sourceRunId: source,
              taskRunId: child,
            }),
          ).toBe(kind === "queued" ? "pending" : "blocked");
          expect(getTaskById(task.taskId)?.deliveryStatus).toBe("pending");
        } finally {
          release?.("abandoned");
          clearAgentRunContext(source);
        }
      });
    },
  );
});

describe("pre-mirror recovery input custody", () => {
  it.each(["current", "prior", "unknown", "unadmitted-prior", "foreign-source", "human"] as const)(
    "retains exact pre-mirror recovery admission after the real recorder commits %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { task, target, entry: original } = await setup(state);
        const claim = captureHarnessCompletionRecovery({
          agentId: "main",
          sessionKey: key,
          entry: original,
          runId: source,
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
            sourceChannel: "internal",
            sourceSessionKey: child,
          },
        });
        if (!claim) {
          throw new Error("real harness task did not bind at admission");
        }
        const entry = {
          ...original,
          ...buildCurrentRunRestartRecoveryClaim({
            entry: original,
            runId: source,
            sourceRunId: source,
            sourceIngress: "internal",
            sourceReplyDeliveryMode: "automatic",
            deliveryContext: { channel: "discord", to: "channel:123", accountId: "main" },
            harnessCompletion: claim,
          }),
        };
        await replaceSessionEntry(target, entry);
        const transcript = { ...target, sessionId: entry.sessionId };
        await appendTranscriptMessage(transcript, {
          message: {
            role: "user",
            content: "completed child",
            idempotencyKey: `${source}:user`,
            __openclaw: { runId: source },
            provenance: {
              kind: "inter_session",
              sourceTool: "agent_harness_task",
              sourceChannel: "internal",
              sourceSessionKey: child,
            },
          },
        });
        const recoveryRunId = "recorder-recovery-current";
        const priorRunId = "recorder-recovery-prior";
        const recovered = {
          ...entry,
          restartRecoveryDeliveryRunId: recoveryRunId,
          restartRecoveryRuns:
            scenario === "prior"
              ? [{ runId: priorRunId, lifecycleGeneration: "retired-gateway" }]
              : [],
        };
        await replaceSessionEntry(target, recovered);
        const guard = createHarnessCompletionSourceAssertion({
          claim,
          storePath: target.storePath,
        });
        const admission = prepareAgentRunAdmission({
          cfg: {},
          facts: {
            agentId: "main",
            runId: recoveryRunId,
            ingress: { kind: "system", boundary: "test-recorder-recovery", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(recoveryRunId),
          assertSourceCurrent: guard,
        });
        try {
          const context = await admission.admit("embedded");
          const effect = resolveAdmittedRunActiveAssertion(context);
          if (!effect) {
            throw new Error("Missing real delegated effect authority");
          }
          effect();
          const inputRunId =
            scenario === "prior" || scenario === "unadmitted-prior"
              ? priorRunId
              : scenario === "unknown"
                ? "unrelated-run"
                : recoveryRunId;
          const recorder = createUserTurnTranscriptRecorder({
            target: { ...transcript, sessionEntry: recovered },
            input: {
              text: "Continue the interrupted task",
              idempotencyKey: `${inputRunId}:user`,
              senderIsOwner: false,
              ...(scenario === "human"
                ? {}
                : {
                    provenance: {
                      kind: "internal_system" as const,
                      sourceTool: "main_session_restart_recovery",
                      sourceSessionKey: scenario === "foreign-source" ? "agent:main:other" : key,
                    },
                  }),
            },
            updateMode: "none",
          });
          const persisted = await recorder.persistApproved();
          expect(persisted?.appended).toBe(true);
          expect(persisted?.message.idempotencyKey).toBe(`${inputRunId}:user`);
          expect(persisted?.message["__openclaw"]?.runId).toBeUndefined();
          if (scenario === "current" || scenario === "prior") {
            expect(effect).not.toThrow();
          } else {
            expect(effect).toThrow();
          }
          expect(getTaskById(task.taskId)?.deliveryStatus).toBe("pending");
        } finally {
          admission.close();
        }
      });
    },
  );
});
