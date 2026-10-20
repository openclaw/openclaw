import type { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { assert, expect, it, vi } from "vitest";
import { readPreparedSessionTranscriptChange } from "../../config/sessions/session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "../../config/sessions/session-transcript-authority.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { sessionManagerAppendInitialMetadata } from "./session-manager-metadata.js";
import { SessionManager } from "./session-manager.js";

it("publishes durable metadata without host SQLite and preserves it after its worker crashes", async () => {
  await withSessionState("metadata-worker-owner", async ({ scope, state }) => {
    const target = { ...scope, env: state.env };
    const options = { agentId: target.agentId, path: target.storePath, env: state.env };
    const native = openOpenClawAgentDatabase(options);
    const statement = Object.getPrototypeOf(native.db.prepare("SELECT 1")) as StatementSync;
    const databasePrototype = Object.getPrototypeOf(native.db);
    await closeOpenClawAgentDatabaseByPathAsync(target.storePath);

    const publications: SessionTranscriptAuthority[] = [];
    const unsubscribe = sessionChanges.subscribeFacts((change) => {
      if (!("sessionKey" in change) || change.sessionKey !== target.sessionKey) {
        return;
      }
      const fact = readPreparedSessionTranscriptChange(change);
      if (fact?.kind === "postimage") {
        publications.push(fact.value);
      }
    });
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    const hostSql = [
      ...(["all", "get", "run", "iterate"] as const).map((method) => vi.spyOn(statement, method)),
      ...(["exec", "prepare"] as const).map((method) => vi.spyOn(databasePrototype, method)),
    ];
    const restoreSql = () => hostSql.forEach((probe) => probe.mockRestore());
    const open = () => SessionManager.openAsync(target, state.workspaceDir);
    const modelChange = { type: "model_change", provider: "synthetic", modelId: "synthetic-model" };
    try {
      const manager = await open();
      const thinking = await manager[sessionManagerAppendInitialMetadata](
        modelChange.provider,
        modelChange.modelId,
        "off",
      );
      const model = manager.getEntries()[0]?.id;
      const initial = [
        { ...modelChange, id: model, parentId: null },
        { id: thinking, type: "thinking_level_change", parentId: model, thinkingLevel: "off" },
      ];
      expect(manager.getEntries()).toMatchObject(initial);
      expect(publications.at(-1)).toMatchObject({
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        leafEventId: thinking,
      });
      const custom = await manager.appendCustomEntryAsync("synthetic-metadata", { retained: true });
      expect(publications.at(-1)?.leafEventId).toBe(custom);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(hostSql.flatMap((probe) => probe.mock.calls)).toEqual([]);
      restoreSql();

      const opening = requests.mock.calls.findIndex(
        ([request]) => request.type === "open" && request.databasePath === target.storePath,
      );
      const worker = requests.mock.contexts[opening];
      assert(worker instanceof Worker, "Metadata did not open its database in a worker");
      // Terminate the native owner without checkpoint/close, preserving the committed WAL.
      await worker.terminate();
      const reopened = await open();
      const expected = [
        ...initial,
        { id: custom, type: "custom", customType: "synthetic-metadata", data: { retained: true } },
      ];
      expect(reopened.getEntries()).toMatchObject(expected);
      const recovered = await reopened.appendCustomEntryAsync("synthetic-recovery", {
        afterCrash: true,
      });
      expect(publications.at(-1)?.leafEventId).toBe(recovered);
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      expect((await open()).getEntries()).toMatchObject([
        ...expected,
        {
          id: recovered,
          type: "custom",
          customType: "synthetic-recovery",
          data: { afterCrash: true },
        },
      ]);
    } finally {
      unsubscribe();
      requests.mockRestore();
      restoreSql();
    }
  });
});
