import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readPreparedSessionTranscriptChange } from "../../config/sessions/session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "../../config/sessions/session-transcript-authority.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

it("publishes durable metadata without host SQLite and preserves it after its worker crashes", async () => {
  await withOpenClawTestState({ label: "metadata-worker-owner" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:metadata-worker-owner",
      sessionId: "metadata-worker-owner",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      env: state.env,
    };
    const options = { agentId: target.agentId, path: target.storePath, env: state.env };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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
      vi.spyOn(statement, "all"),
      vi.spyOn(statement, "get"),
      vi.spyOn(statement, "run"),
      vi.spyOn(statement, "iterate"),
      vi.spyOn(databasePrototype, "exec"),
      vi.spyOn(databasePrototype, "prepare"),
    ];
    try {
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const model = await manager.appendModelChange("synthetic", "synthetic-model");
      expect(publications.at(-1)).toMatchObject({
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        leafEventId: model,
      });
      const thinking = await manager.appendThinkingLevelChange("off");
      expect(publications.at(-1)?.leafEventId).toBe(thinking);
      const custom = await manager.appendCustomEntryAsync("synthetic-metadata", { retained: true });
      expect(publications.at(-1)?.leafEventId).toBe(custom);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(hostSql.flatMap((probe) => probe.mock.calls)).toEqual([]);
      for (const probe of hostSql) {
        probe.mockRestore();
      }

      const opening = requests.mock.calls.findIndex(
        ([request]) => request.type === "open" && request.databasePath === target.storePath,
      );
      const worker = requests.mock.contexts[opening];
      if (!(worker instanceof Worker)) {
        throw new Error("Metadata did not open its database in a worker");
      }
      // Terminate the native owner without checkpoint/close, preserving the committed WAL.
      await worker.terminate();
      const reopened = await SessionManager.openAsync(target, state.workspaceDir);
      const expected = [
        { id: model, type: "model_change", provider: "synthetic", modelId: "synthetic-model" },
        { id: thinking, type: "thinking_level_change", thinkingLevel: "off" },
        { id: custom, type: "custom", customType: "synthetic-metadata", data: { retained: true } },
      ];
      expect(reopened.getEntries()).toMatchObject(expected);
      const recovered = await reopened.appendCustomEntryAsync("synthetic-recovery", {
        afterCrash: true,
      });
      expect(publications.at(-1)?.leafEventId).toBe(recovered);
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      const durable = await SessionManager.openAsync(target, state.workspaceDir);
      expect(durable.getEntries()).toMatchObject([
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
      for (const probe of hostSql) {
        probe.mockRestore();
      }
    }
  });
});
