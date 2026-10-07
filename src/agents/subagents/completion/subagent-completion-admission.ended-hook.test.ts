import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as hookRunnerGlobal from "../../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRegistryContextCleanup } from "../registry/subagent-registry-context-cleanup.js";
import * as registryDeps from "../registry/subagent-registry-deps.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import { mutateRequesterSettleWakeBatch } from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun,
  admitCompletionFixtureDatabase,
  armRequesterWake,
  records,
  seedSubagentCompletionDelivery,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

it.each(["transition", "complete"] as const)(
  "publishes a requester wake %s before recording its concurrent ended hook",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const input = armRequesterWake(records());
      await admitCompletionFixtureDatabase();
      seedSubagentCompletionDelivery({ subagent: input.subagent });
      subagentRuns.set(input.subagent.runId, input.subagent);
      const registry = createEmptyPluginRegistry();
      const hookRunner = createHookRunner(registry);
      const hookReached = createDeferred();
      const runtime = vi
        .spyOn(registryDeps, "loadSubagentRegistryPluginRuntimeHandle")
        .mockResolvedValue(registry);
      const hooks = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockImplementation(() => {
        hookReached.resolve();
        return hookRunner;
      });
      const warn = vi.fn();
      const cleanup = createSubagentRegistryContextCleanup({
        isEndedHookOwnerCurrent: (entry) =>
          isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry),
        warn,
      });
      const acknowledged = createDeferred();
      const releaseAcknowledgement = createDeferred();
      const runWorker = stateWorker.runOpenClawStateWorkerOperation;
      const worker = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation((context, run, options) =>
          runWorker(
            context,
            (scope) =>
              run({
                execute: async (command, executeOptions) => {
                  const receipt = await scope.execute(command, executeOptions);
                  if (command.type === "sessionDelivery.mutateSubagentCompletion") {
                    acknowledged.resolve();
                    await releaseAcknowledgement.promise;
                  }
                  return receipt;
                },
              }),
            options,
          ),
        );
      const publication = mutateRequesterSettleWakeBatch({
        entries: [input.subagent],
        operation:
          operation === "complete"
            ? { kind: "complete" }
            : {
                kind: "transition",
                state: { status: "dispatching", attemptCount: 1, rearmGeneration: 1 },
              },
        context: captureOpenClawStateWorkerContext(),
        assertCurrent: () => {
          if (subagentRuns.get(input.subagent.runId) !== input.subagent) {
            throw new Error("Requester wake lost its registered owner");
          }
        },
        onCommitted: () => {},
        onPublished: () => {},
      });
      let hook: Promise<void> | undefined;
      try {
        await Promise.race([
          acknowledged.promise,
          publication.then(() => {
            throw new Error("Requester wake returned before its held acknowledgement");
          }),
        ]);
        hook = cleanup.emitSubagentEndedHookForRun({ entry: input.subagent });
        await Promise.race([
          hookReached.promise,
          hook.then(() => {
            throw new Error("Ended hook returned before reaching its producer");
          }),
        ]);
        expect.soft(input.subagent.endedHookEmittedAt).toBeUndefined();
        releaseAcknowledgement.resolve();
        await expect(publication).resolves.toEqual({ applied: true, publication: "published" });
        await hook;
        expect(currentCompletionRun(input).endedHookEmittedAt).toEqual(expect.any(Number));
        const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
        expect(stored?.endedHookEmittedAt).toBe(currentCompletionRun(input).endedHookEmittedAt);
        if (operation === "complete") {
          expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
          expect(stored?.requesterSettleWake).toBeUndefined();
        } else {
          expect(currentCompletionRun(input).requesterSettleWake).toMatchObject({
            status: "dispatching",
            attemptCount: 1,
            rearmGeneration: 1,
          });
          expect(stored?.requesterSettleWake).toEqual(
            currentCompletionRun(input).requesterSettleWake,
          );
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        releaseAcknowledgement.resolve();
        await Promise.allSettled([publication, ...(hook ? [hook] : [])]);
        worker.mockRestore();
        hooks.mockRestore();
        runtime.mockRestore();
        subagentRuns.delete(input.subagent.runId);
      }
    });
  },
);
