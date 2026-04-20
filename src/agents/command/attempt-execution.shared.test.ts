import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { persistSessionEntry } from "./attempt-execution.shared.js";

async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-execution-shared-"));
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("persistSessionEntry", () => {
  it("keeps lastInteractionAt monotonic when a stale write lands late", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-persist-session-entry";
      const sessionId = "test-session-persist-session-entry";
      const newerLastInteractionAt = 2_000;

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId,
              updatedAt: newerLastInteractionAt,
              lastInteractionAt: newerLastInteractionAt,
            },
          },
          null,
          2,
        ),
      );

      const staleSessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1_000,
          lastInteractionAt: 1_000,
        },
      };

      await persistSessionEntry({
        sessionStore: staleSessionStore,
        sessionKey,
        storePath,
        entry: {
          ...staleSessionStore[sessionKey],
          sessionId,
          updatedAt: 1_000,
          lastInteractionAt: 1_000,
          thinkingLevel: "high",
        },
      });

      expect(staleSessionStore[sessionKey]?.lastInteractionAt).toBe(newerLastInteractionAt);
      expect(staleSessionStore[sessionKey]?.thinkingLevel).toBe("high");

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(persisted[sessionKey]?.lastInteractionAt).toBe(newerLastInteractionAt);
      expect(persisted[sessionKey]?.thinkingLevel).toBe("high");
    });
  });
});
