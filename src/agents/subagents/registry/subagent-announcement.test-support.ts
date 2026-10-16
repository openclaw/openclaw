import { vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as hookRuntime from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import type { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../../state/openclaw-state-worker-store.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import type { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const registrationDefaults = {
  childAgentId: "main",
  requesterSessionKey: "agent:main:main",
  requesterAgentId: "main",
  requesterDisplayKey: "main",
  cleanup: "keep" as const,
  expectsCompletionMessage: false,
};

export function installEndedHook(handler: () => Promise<void>) {
  const { registry, runner } = createHookRunnerWithRegistry([
    { hookName: "subagent_ended", handler },
  ]);
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(registry);
  vi.spyOn(hookRuntime, "getGlobalHookRunner").mockReturnValue(runner);
  return registry;
}

export function completeRegistered(
  run: Pick<SubagentRunRecord, "runId" | "childSessionKey">,
  text = "Synthetic completed result.",
) {
  emitAgentEvent({
    runId: run.runId,
    sessionKey: run.childSessionKey,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now(), terminalReply: { disposition: "visible", text } },
  });
}

export function updateRun(runId: string, edit: (draft: SubagentRunRecord) => void) {
  return mutateSubagentRuns([runId], (rows) => {
    const next = structuredClone(rows.get(runId)!);
    edit(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });
}

export function suspendRun(runId: string) {
  return updateRun(runId, (draft) => {
    draft.delivery = {
      ...draft.delivery,
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
    };
  });
}

export function registerSuccessor(
  run: SubagentRunRecord,
  task: string,
  options: Partial<RegisterSubagentRunParams> = {},
) {
  return registerSubagentRun({
    ...registrationDefaults,
    runId: run.runId,
    childSessionKey: run.childSessionKey,
    sessionEntry: run.childSessionIdentity,
    task,
    ...options,
  });
}

export function announcementFixture(
  fixture: ReturnType<typeof useSubagentControlFixture>,
  delivery: boolean,
) {
  return async (
    runId: string,
    options: Partial<
      Pick<
        RegisterSubagentRunParams,
        "cleanup" | "expectsCompletionMessage" | "requesterSessionKey"
      >
    > & { holdForRequester?: boolean } = {},
  ) => {
    const { holdForRequester, ...overrides } = options;
    const childSessionKey = `agent:main:subagent:${runId}`;
    const sessionEntry = {
      sessionId: delivery ? `${runId}-session` : "ordinary-child-session",
      lifecycleRevision: delivery ? "original-child" : "ordinary-child-revision",
    };
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childSessionKey,
      defaultSessionId: sessionEntry.sessionId,
      lifecycleRevision: sessionEntry.lifecycleRevision,
    });
    fixture.capture.mockResolvedValue("Synthetic completed result.");
    let gatewayContextResolver: RegisterSubagentRunParams["gatewayContextResolver"];
    if (delivery) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: "agent:main:main",
        defaultSessionId: "synthetic-requester-session",
        lifecycleRevision: "original-requester",
      });
      const context = createContext();
      context.localEmbedded = true;
      context.getRuntimeConfig = getRuntimeConfig;
      context.chatAbortControllers = new Map();
      context.chatQueuedTurns = new Map();
      const registry = createGatewayMethodRegistry([
        {
          name: "agent",
          owner: { kind: "core", area: "test" },
          scope: WRITE_SCOPE,
          handler: () => {
            throw new Error("Expected the typed agent turn facade");
          },
        },
      ]);
      context.getGatewayMethodRegistry = () => registry;
      gatewayContextResolver = () => context;
    } else {
      fixture.wake.mockResolvedValue(false);
    }
    await registerSubagentRun({
      ...registrationDefaults,
      runId,
      childSessionKey,
      sessionEntry,
      task: delivery
        ? "retain ordinary cleanup before requester settlement"
        : "finish ordinary cleanup",
      expectsCompletionMessage: delivery || holdForRequester === true,
      ...(holdForRequester
        ? { completionTarget: "parent", requesterTurnRunId: "held-requester-turn" }
        : {}),
      ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
      ...overrides,
    });
    return { runId, childSessionKey };
  };
}

export const currentRun = (runId: string) => subagentRuns.get(runId);
export const storedAnnouncement = (
  runId: string,
  database?: Parameters<typeof loadSubagentRegistryFromSqlite>[0],
) => loadSubagentRegistryFromSqlite(database).get(runId);

export function withUnreadableReceipt<T>(
  run: typeof runOpenClawStateWorkerOperation,
  context: Parameters<typeof runOpenClawStateWorkerOperation>[0],
  operation: (scope: DomainScope) => Promise<T>,
  options: Parameters<typeof runOpenClawStateWorkerOperation>[2],
  select: (command: Parameters<DomainScope["execute"]>[0]) => boolean,
  onLost: () => void,
) {
  let admission: SqliteWorkerOperationAdmission | undefined;
  const createAdmission = options?.createAdmission;
  return run(
    context,
    (scope) =>
      operation({
        async execute(command, executeOptions) {
          const selected = select(command);
          const result = await scope.execute(command, executeOptions);
          if (selected) {
            onLost();
            admission?.service();
            if (!admission?.committed) {
              throw new Error(
                "Expected the native commit receipt before losing its acknowledgement",
              );
            }
            Object.defineProperty(admission, "committed", { value: { facts: undefined } });
            throw new SqliteWorkerError(
              "Synthetic unreadable registry acknowledgement",
              "outcome-unknown",
            );
          }
          return result;
        },
      }),
    {
      ...options,
      createAdmission: createAdmission
        ? (operationAdmission) => {
            const created = createAdmission(operationAdmission);
            admission = created.admission;
            return created;
          }
        : undefined,
    },
  );
}
