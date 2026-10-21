import { assert, onTestFinished, vi } from "vitest";
import { getRuntimeConfig } from "../../../config/config.js";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import * as hookRuntime from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import type { runOpenClawStateWorkerOperation as runWorker } from "../../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../../state/openclaw-state-worker-store.types.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import type { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { RegisterSubagentRunParams as Registration } from "./subagent-registry-run-launch-record.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeChildSession } from "./subagent-registry.persistence.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const registrationDefaults = {
  childAgentId: "main",
  requesterSessionKey: "agent:main:main",
  requesterAgentId: "main",
  requesterDisplayKey: "main",
  cleanup: "keep" as const,
  expectsCompletionMessage: false,
};
const rejectUntypedTurn = () => assert.fail("Expected the typed agent turn facade");

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

export const updateRun = (runId: string, edit: (draft: SubagentRunRecord) => void) =>
  mutateSubagentRuns([runId], (rows) => {
    const next = structuredClone(rows.get(runId)!);
    edit(next);
    return { value: undefined, postimages: new Map([[runId, next]]) };
  });

export const suspendRun = (runId: string) =>
  updateRun(runId, (draft) => {
    draft.delivery = {
      ...draft.delivery,
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
    };
  });

export const registerSuccessor = (
  run: SubagentRunRecord,
  task: string,
  options: Partial<Registration> = {},
) =>
  registerSubagentRun({
    ...registrationDefaults,
    runId: run.runId,
    childSessionKey: run.childSessionKey,
    sessionEntry: run.childSessionIdentity,
    task,
    ...options,
  });

export function announcementFixture(
  fixture: ReturnType<typeof useSubagentControlFixture>,
  delivery: boolean,
) {
  return async (
    runId: string,
    options: Partial<
      Pick<Registration, "cleanup" | "expectsCompletionMessage" | "requesterSessionKey">
    > & { holdForRequester?: boolean } = {},
  ) => {
    const { holdForRequester, ...overrides } = options;
    const write = writeChildSession.bind(null, fixture.stateDir);
    const childSessionKey = `agent:main:subagent:${runId}`;
    const sessionEntry = {
      sessionId: delivery ? `${runId}-session` : "ordinary-child-session",
      lifecycleRevision: delivery ? "original-child" : "ordinary-child-revision",
    };
    await write(childSessionKey, sessionEntry.sessionId, sessionEntry.lifecycleRevision);
    fixture.capture.mockResolvedValue("Synthetic completed result.");
    let gatewayContextResolver: Registration["gatewayContextResolver"];
    if (delivery) {
      await write("agent:main:main", "synthetic-requester-session", "original-requester");
      const context = createContext(
        [["agent", WRITE_SCOPE, "test", rejectUntypedTurn]],
        getRuntimeConfig,
      );
      context.localEmbedded = true;
      gatewayContextResolver = () => context;
    } else {
      fixture.wake.mockResolvedValue(false);
      if (holdForRequester) {
        // The session controller owns the spawning requester turn.
        const { holdLiveRequesterTurns } =
          await import("./subagent-requester-turn-liveness.test-support.js");
        onTestFinished(holdLiveRequesterTurns("held-requester-turn").restore);
      }
    }
    await registerSubagentRun({
      ...registrationDefaults,
      runId,
      childSessionKey,
      sessionEntry,
      task: "finish ordinary cleanup",
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
  run: typeof runWorker,
  context: Parameters<typeof runWorker>[0],
  operation: (scope: DomainScope) => Promise<T>,
  options: Parameters<typeof runWorker>[2],
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
          if (!selected) {
            return result;
          }
          onLost();
          admission?.service();
          assert(admission?.committed, "Missing committed native receipt");
          Object.defineProperty(admission, "committed", { value: { facts: undefined } });
          throw new SqliteWorkerError("Unreadable registry acknowledgement", "outcome-unknown");
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
