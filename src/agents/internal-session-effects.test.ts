import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
  loadExactSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  createInternalSessionEffectsCleanup,
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
} from "./internal-session-effects.js";

describe("internal session effects", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-internal-session-effects-");
  it("keeps hidden effects from an incognito run in the sentinel store", async () => {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    try {
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "incognito-run",
        storePath,
      });

      expect(target.sessionKey).toMatch(
        /^agent:main:internal-session-effects:incognito-incognito-run-/,
      );
      expect(loadExactSessionEntry(target)?.entry.incognito).toBe(true);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("does not archive an incognito internal-effects transcript during rotation", async () => {
    const dir = tempDirs.make();
    await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      try {
        const target = await prepareInternalSessionEffectsSession({
          agentId: "main",
          runId: "rotation",
          storePath,
        });
        const previousTranscript = path.join(dir, "private-internal.jsonl");
        await fs.writeFile(
          previousTranscript,
          `${JSON.stringify({
            type: "session",
            version: 3,
            id: target.sessionId,
            timestamp: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        const previousEntry = await upsertSessionEntryCore(target, {
          ...target.sessionEntry,
          sessionFile: previousTranscript,
        });
        if (!previousEntry) {
          throw new Error("failed to seed incognito internal-effects entry");
        }
        const nextTranscript = path.join(dir, "next-internal.jsonl");

        await applySessionEntryLifecycleMutation({
          agentId: "main",
          activeSessionKey: target.sessionKey,
          storePath,
          upserts: [
            {
              sessionKey: target.sessionKey,
              entry: {
                ...previousEntry,
                sessionFile: nextTranscript,
                sessionId: "internal-session-effects-rotated",
                updatedAt: Date.now(),
              },
              resetBoundary: { context: "preserve-tail", reason: "reset", cwd: dir },
            },
          ],
          skipMaintenance: true,
        });

        expect(await fs.readdir(dir)).toContain("private-internal.jsonl");
        expect((await fs.readdir(dir)).some((name) => name.includes(".reset."))).toBe(false);
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("creates a hidden deterministic SQLite session", async () => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      cwd: dir,
      runId: "run/with space",
      storePath,
    });

    expect(target.sessionKey).toMatch(/^agent:main:internal-session-effects:run_with_space-/);
    expect(target.sessionId).toMatch(/^internal-session-effects-run_with_space-/);
    expect(loadExactSessionEntry(target)?.entry).toMatchObject({
      sessionId: target.sessionId,
      createdVia: "internal",
      createdActor: { type: "system" },
      delivery: { kind: "internal" },
      createdAt: expect.any(Number),
    });
    expect(listSessionEntriesCore({ agentId: "main", storePath })).toEqual([]);
    await expect(loadTranscriptEvents(target)).resolves.toEqual([
      expect.objectContaining({ id: target.sessionId, type: "session" }),
    ]);

    const reopened = await prepareInternalSessionEffectsSession({
      agentId: "main",
      cwd: dir,
      runId: "run/with space",
      storePath,
    });
    expect(reopened).toEqual(target);
  });

  it("escapes the reserved prefix for a durable internal-effects run id", async () => {
    const dir = tempDirs.make();
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "incognito-not-private",
      storePath: path.join(dir, "sessions.json"),
    });

    expect(target.sessionKey).toMatch(
      /^agent:main:internal-session-effects:legacy-incognito-not-private-/,
    );
  });

  it.each(["copy", "reopen"] as const)("requires the current owner during %s", async (phase) => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const source = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "required-source",
      storePath,
    });
    await appendTranscriptMessage(source, {
      message: { role: "assistant", content: "retained progress", timestamp: 1 },
    });
    const request = {
      agentId: "main",
      runId: "required-successor",
      source,
      storePath,
    };
    if (phase === "reopen") {
      await prepareInternalSessionEffectsSession(request);
    }
    let current = phase === "copy";
    await expect(
      prepareInternalSessionEffectsSession({
        ...request,
        commitGuard: () => {
          if (!current) {
            throw new Error("recovery owner retired");
          }
          queueMicrotask(() => {
            current = false;
          });
        },
      }),
    ).rejects.toThrow("recovery owner retired");
    expect(JSON.stringify(await loadTranscriptEvents(source))).toContain("retained progress");
  });

  it.each([true, false])(
    "cleans only the latest tracked hidden identities when enabled=%s",
    async (enabled) => {
      const dir = tempDirs.make();
      const storePath = path.join(dir, "sessions.json");
      const errors: unknown[] = [];
      const cleanup = createInternalSessionEffectsCleanup({
        enabled,
        agentId: "main",
        runId: "tracked-run",
        storePath,
        onError: (error) => errors.push(error),
      });
      const initial = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "tracked-run",
        storePath,
      });
      const rotated = {
        agentId: initial.agentId,
        sessionId: "rotated-hidden-session",
        sessionKey: initial.sessionKey,
        storePath,
      };
      await upsertSessionEntryCore(rotated, { sessionId: rotated.sessionId, updatedAt: 2 });
      const additional = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "additional-binding",
        storePath,
      });
      const untracked = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "other-run",
        storePath,
      });
      const untrackedBefore = structuredClone(loadExactSessionEntry(untracked));
      expect(untrackedBefore).toBeDefined();
      for (const target of [rotated, additional]) {
        await appendTranscriptMessage(target, {
          message: { role: "assistant", content: "private", timestamp: 3 },
        });
        cleanup.track(target);
      }

      await cleanup.cleanup();

      expect(errors).toEqual([]);
      expect(loadExactSessionEntry(untracked)).toEqual(untrackedBefore);
      for (const target of [rotated, additional]) {
        if (enabled) {
          expect(loadExactSessionEntry(target)).toBeUndefined();
          await expect(loadTranscriptEvents(target)).resolves.toEqual([]);
        } else {
          expect(loadExactSessionEntry(target)?.entry.sessionId).toBe(target.sessionId);
          await expect(loadTranscriptEvents(target)).resolves.toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ role: "assistant", content: "private" }),
            }),
          );
        }
      }
    },
  );

  it("hard-deletes the hidden entry and transcript rows", async () => {
    const dir = tempDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const target = await prepareInternalSessionEffectsSession({
      agentId: "main",
      runId: "run-cleanup",
      storePath,
    });
    await appendTranscriptMessage(target, {
      message: { content: "private", role: "assistant", timestamp: 2 },
    });

    await removeInternalSessionEffectsSession(target);

    expect(loadExactSessionEntry(target)).toBeUndefined();
    await expect(loadTranscriptEvents(target)).resolves.toEqual([]);
  });
});
