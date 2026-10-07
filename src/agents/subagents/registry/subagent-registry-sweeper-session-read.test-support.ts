import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import * as sessionEntryReads from "../../../config/sessions/session-entry-read-runtime.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentSweeperHarness as createHarness } from "./subagent-registry-sweeper.test-support.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";

export function registerSubagentSweeperSessionReadTests(ignoreRecovery: () => void) {
  it("classifies orphanhood and completion from the same worker snapshot during a session rewrite", async () => {
    const actual = await vi.importActual<typeof import("./subagent-session-reconciliation.js")>(
      "./subagent-session-reconciliation.js",
    );
    await vi
      .mocked(loadSubagentSessionEntry)
      .withImplementation(actual.loadSubagentSessionEntry, async () => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          ignoreRecovery();
          const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness({});
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: "agent:main:read-source", env: state.env },
            { sessionId: "read-source", updatedAt: Date.now() },
          );
          const readStarted = createDeferred();
          const release = createDeferred();
          const readEntry = sessionEntryReads.readSessionEntryReadOnlyInWorker;
          let held = false;
          using read = vi.spyOn(sessionEntryReads, "readSessionEntryReadOnlyInWorker");
          read.mockImplementation(async (...args) => {
            const snapshot = await readEntry(...args);
            if (!held && args[0].sessionKey === entry.childSessionKey) {
              held = true;
              expect(snapshot).toBeUndefined();
              readStarted.resolve();
              await release.promise;
            }
            return snapshot;
          });
          const pending = sweeper.sweepOnce();
          try {
            await awaitGateBeforeSettlement(
              readStarted.promise,
              pending,
              "Sweep did not read the missing child",
            );
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: entry.childSessionKey, env: state.env },
              {
                sessionId: "rewritten-session",
                updatedAt: Date.now(),
                startedAt: entry.execution.startedAt,
                endedAt: Date.now(),
                status: "done",
              },
            );
            release.resolve();
            await pending;
            expect(completeSubagentRunWithRecovery).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                runId: entry.runId,
                expectedEntry: entry,
                outcome: { status: "error", error: "subagent run orphaned: missing-session-entry" },
              }),
              "sweeper-lost-context",
            );
            expect(
              loadSessionEntryReadOnly({
                agentId: "main",
                sessionKey: entry.childSessionKey,
                env: state.env,
              })?.sessionId,
            ).toBe("rewritten-session");
          } finally {
            release.resolve();
            await pending;
            await sweeper.reset();
          }
        });
      });
  });

  it("does not manufacture terminal completion when the child worker read rejects", async () => {
    const actual = await vi.importActual<typeof import("./subagent-session-reconciliation.js")>(
      "./subagent-session-reconciliation.js",
    );
    await vi
      .mocked(loadSubagentSessionEntry)
      .withImplementation(actual.loadSubagentSessionEntry, async () => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          ignoreRecovery();
          const { entry, runs, completeSubagentRunWithRecovery, sweeper } = createHarness({});
          const scope = {
            agentId: "main",
            sessionKey: entry.childSessionKey,
            storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
              agentId: "main",
            }),
            env: state.env,
          };
          replaceSessionEntrySync(scope, { sessionId: "invalid-child", updatedAt: Date.now() });
          const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
          database.db
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
            )
            .run('{"bad":true}', entry.childSessionKey);
          try {
            await expect(sweeper.sweepOnce()).rejects.toThrow(
              "invalid persisted session row requires repair",
            );
            expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
            expect(runs.get(entry.runId)).toBe(entry);
            expect(entry.execution.endedAt).toBeUndefined();
          } finally {
            await sweeper.reset();
          }
        });
      });
  });
}
