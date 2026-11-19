import type { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { assert, expect, it, vi } from "vitest";
import { readPreparedSessionCompactionInWorker } from "../../config/sessions/session-compaction-prepared.js";
import { readPreparedSessionTranscriptChange } from "../../config/sessions/session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "../../config/sessions/session-transcript-authority.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { initializePreparedCompactionMetadata } from "../embedded-agent-runner/prepared-compaction-metadata.js";
import { createSessionHeader } from "./session-initial-metadata.js";
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
      const fact =
        "sessionKey" in change &&
        change.sessionKey === target.sessionKey &&
        readPreparedSessionTranscriptChange(change);
      if (fact && fact.kind === "postimage") {
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
      const metadata = { customType: "synthetic-metadata", data: { retained: true } };
      const custom = await manager.appendCustomEntryAsync(metadata.customType, {
        ...metadata.data,
      });
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
      const expected = [...initial, { id: custom, type: "custom", ...metadata }];
      expect(reopened.getEntries()).toMatchObject(expected);
      const recovery = { customType: "synthetic-recovery", data: { afterCrash: true } };
      const recovered = await reopened.appendCustomEntryAsync(recovery.customType, {
        ...recovery.data,
      });
      expect(publications.at(-1)?.leafEventId).toBe(recovered);
      await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
      expect((await open()).getEntries()).toMatchObject([
        ...expected,
        { id: recovered, type: "custom", ...recovery },
      ]);
    } finally {
      unsubscribe();
      requests.mockRestore();
      restoreSql();
    }
  });
});

it("initializes bounded compaction metadata through the native owner without duplicating it", async () => {
  await withSessionState("bounded-compaction-metadata", async ({ scope, state }) => {
    const target = { ...scope, env: state.env };
    const model = {
      provider: "synthetic",
      modelId: "reasoner",
      modelApi: "openai-responses",
      thinkingLevel: "max",
    };
    await initializePreparedCompactionMetadata(
      target,
      {
        hasExistingSession: false,
        hasThinkingEntry: false,
        leafEntryId: null,
        lastModelSnapshot: null,
      },
      model,
      () => undefined,
      createSessionHeader(target.sessionId, state.workspaceDir),
    );
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const entries = manager.getEntries();
    expect(entries).toMatchObject([
      { type: "model_change", provider: "synthetic", modelId: "reasoner", parentId: null },
      { type: "thinking_level_change", thinkingLevel: "max", parentId: entries[0]?.id },
      {
        type: "custom",
        customType: "model-snapshot",
        parentId: entries[1]?.id,
        data: { provider: "synthetic", modelId: "reasoner", modelApi: "openai-responses" },
      },
    ]);
    const userId = await manager.appendMessageAsync({
      role: "user",
      content: "Keep this conversation.",
      timestamp: 1,
    });
    assert(userId !== undefined, "user message must be persisted before compaction");
    await manager.appendCompactionAsync("Earlier conversation", userId, 100);
    const populated = manager.getEntries();
    const preflight = await readPreparedSessionCompactionInWorker(target, { kind: "preflight" });
    assert(preflight.status === "preflight");
    expect(preflight.source.metadata).toMatchObject({
      hasExistingSession: true,
      hasThinkingEntry: true,
      lastModelSnapshot: {
        provider: model.provider,
        modelId: model.modelId,
        modelApi: model.modelApi,
      },
    });
    // Thinking and snapshots precede the retained compaction suffix but still initialize SDK state.
    expect(preflight.source.entries.some((entry) => entry.type === "thinking_level_change")).toBe(
      false,
    );
    await initializePreparedCompactionMetadata(
      target,
      preflight.source.metadata,
      model,
      () => undefined,
    );
    const reopened = await SessionManager.openAsync(target, state.workspaceDir);
    expect(reopened.getEntries()).toEqual(populated);
  });
});
