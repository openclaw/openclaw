import fs from "node:fs/promises";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildSessionEntry, listSessionTranscriptCorpusEntriesForAgent } from "./session-files.js";

describe("session archive identity", () => {
  it("classifies canonical archives after owner writes without caller-thread SQLite", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionsDir = state.sessionsDir();
      const sessionId = "classified-archive";
      const sessionKey = "agent:main:chat:classified-archive";
      const storePath = path.join(sessionsDir, "sessions.json");
      const archivePath = path.join(
        sessionsDir,
        `${sessionId}.jsonl.reset.2026-10-01T12-00-00.000Z`,
      );
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        archivePath,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Retained archive text." },
        }),
      );

      for (const classification of [
        { spawnedBy: undefined, dreaming: false, cron: false },
        { spawnedBy: "agent:main:dreaming-narrative-run", dreaming: true, cron: false },
        { spawnedBy: "agent:main:cron:job-1:run:run-1", dreaming: false, cron: true },
      ]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt: 1, spawnedBy: classification.spawnedBy },
        );
        const observed = observeHostDataSql();
        try {
          const entry = await buildSessionEntry(archivePath);
          expect(entry?.generatedByDreamingNarrative === true).toBe(classification.dreaming);
          expect(entry?.generatedByCronRun === true).toBe(classification.cron);
          expect(entry?.content).toBe(
            classification.dreaming || classification.cron
              ? ""
              : "Assistant: Retained archive text.",
          );
          expect(observed.queries).toEqual([]);
        } finally {
          observed.restore();
        }
      }
    });
  });

  it("keeps registered archives from a shared custom store", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.root, "custom", "shared.sqlite");
      const sessionId = `oversized-${"x".repeat(300)}`;
      const sessionKey = "agent:main:chat:archived-custom";
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await state.writeConfig({ session: { store: storePath } });
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        { message: { role: "user", content: "Retain custom-store archive identity." } },
      );
      const deleted = await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest();

      const archivedPath = deleted.archivedTranscripts[0]?.archivedPath;
      expect(archivedPath).toEqual(expect.any(String));
      await expect(listSessionTranscriptCorpusEntriesForAgent("main")).resolves.toContainEqual(
        expect.objectContaining({
          artifactKind: "archive-artifact",
          sessionFile: archivedPath,
          sessionId,
          sessionKey,
          storePath,
        }),
      );
    });
  });
});
