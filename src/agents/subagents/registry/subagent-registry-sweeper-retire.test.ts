import { afterAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import { createSubagentSweeperRun as run } from "./subagent-registry-sweeper.test-support.js";
import type { SubagentRegistryWrite } from "./subagent-registry.store.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
// mock-isolation: Cleanup is gated by the race fixture without deleting real internal-session effects.
vi.mock("../../internal-session-effects.js", () => ({ removeInternalSessionEffectsSession }));
afterAll(() => clearRuntimeConfigSnapshot());

describe("superseded subagent retirement", () => {
  it.each([
    { refused: false, retireSuccessor: false },
    { refused: true, retireSuccessor: false },
    { refused: false, retireSuccessor: true },
  ])(
    "publishes retirement after durable deletion (refused: $refused, successor retires during cleanup: $retireSuccessor)",
    async ({ refused, retireSuccessor }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({
          session: { store: state.statePath("agents/{agentId}/sessions/sessions.json") },
        });
        const entry = run();
        if (retireSuccessor) {
          entry.execution.transcriptTarget = {
            agentId: "main",
            sessionId: "retired-transcript",
            sessionKey: "agent:main:internal-session-effects:retired",
            storePath: state.sessionsDir("main"),
          };
        }
        const cleanupEntered = createDeferred();
        const releaseCleanup = createDeferred();
        if (retireSuccessor) {
          removeInternalSessionEffectsSession.mockImplementationOnce(async () => {
            cleanupEntered.resolve();
            await releaseCleanup.promise;
          });
        }
        const successor = { ...run(), runId: "successor", generation: (entry.generation ?? 0) + 1 };
        const runs = new Map<string, SubagentRunRecord>();
        await mutateSubagentRuns(
          [entry.runId, successor.runId],
          () => ({
            value: undefined,
            postimages: new Map([
              [entry.runId, entry],
              [successor.runId, successor],
            ]),
          }),
          { runs },
        );
        const clearPendingLifecycleError = vi.fn();
        const worker = probe.command(stateWorker, async (command, executeOptions, scope) => {
          if (
            refused &&
            command.type === "subagents.persistChanges" &&
            (command.input as SubagentRegistryWrite).deleteRunIds.includes(entry.runId)
          ) {
            throw new Error("registry deletion failed");
          }
          return scope.execute(command, executeOptions);
        });
        try {
          const deletion = retireSupersededSubagentRun({
            runId: entry.runId,
            entry,
            runs,
            clearPendingLifecycleError,
          });
          if (retireSuccessor) {
            try {
              await cleanupEntered.promise;
              await mutateSubagentRuns(
                [successor.runId],
                () => ({
                  value: undefined,
                  postimages: new Map([[successor.runId, null]]),
                }),
                { runs },
              );
            } finally {
              releaseCleanup.resolve();
            }
          }
          if (refused) {
            await expect(deletion).rejects.toThrow("registry deletion failed");
          } else {
            await deletion;
          }
          const persisted = await executeExistingOpenClawStateRead(
            { env: state.env },
            {
              type: "subagents.runs",
              scope: { kind: "ids", runIds: [entry.runId, successor.runId] },
            },
          );
          if (!persisted?.ok || persisted.type !== "subagents.runs" || persisted.projection) {
            throw new Error("Retirement fixture could not read durable rows");
          }
          expect(runs.has(entry.runId)).toBe(refused);
          expect(persisted.runs.has(entry.runId)).toBe(refused);
          expect(persisted.runs.has(successor.runId)).toBe(!retireSuccessor);
          if (refused) {
            expect(clearPendingLifecycleError).not.toHaveBeenCalled();
          } else {
            expect(clearPendingLifecycleError).toHaveBeenCalledExactlyOnceWith(entry.runId);
          }
        } finally {
          worker.mockRestore();
        }
      });
    },
  );
});
