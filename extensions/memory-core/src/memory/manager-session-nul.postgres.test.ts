import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { createPostgresIndexFixture } from "./postgres-index.test-support.js";

describe.each(["sqlite", "postgres"] as const)("%s NUL-bearing session memory", (engine) => {
  const fixture = createPostgresIndexFixture("memory_session_nul", engine, (workspace) => ({
    database: { engine },
    plugins: { enabled: false },
    agents: { entries: { main: { workspace } } },
    memory: {
      search: {
        provider: "none",
        fallback: "none",
        sources: ["sessions"],
        rememberAcrossConversations: true,
        store: { vector: { enabled: false } },
        query: { minScore: 0 },
      },
    },
  }));
  afterEach(() => fixture.run(() => closeAllMemorySearchManagers()));
  it.skipIf(fixture.unavailable)(
    "indexes and searches both sides of NUL without a provider",
    async () =>
      fixture.run(async () => {
        const sessionId = "nul-memory";
        const sessionKey = "agent:main:memory:nul-memory";
        const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
        await fs.mkdir(sessionsDir, { recursive: true });
        const target = {
          agentId: "main",
          sessionKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        };
        await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: 1 } });
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          sessionId,
          message: {
            role: "user",
            timestamp: 1,
            content: [{ type: "text", text: "Alphanulmarker\u0000Betanulmarker" }],
            __openclaw: { senderIsOwner: true },
          },
        });
        const before = JSON.stringify(await readSessionTranscriptEvents({ ...target, sessionId }));
        expect(before).toContain("\\u0000");
        const result = await getMemorySearchManager({
          cfg: fixture.config,
          agentId: "main",
          purpose: "cli",
          runInBackgroundContext: fixture.run,
        });
        assert(result.manager, result.error ?? "memory manager unavailable");
        assert(typeof result.manager.sync === "function");
        await result.manager.sync({ reason: "cli", force: true });
        expect(JSON.stringify(await readSessionTranscriptEvents({ ...target, sessionId }))).toBe(
          before,
        );
        for (const marker of ["Alphanulmarker", "Betanulmarker"]) {
          const hits = await result.manager.search(marker, {
            lexicalOnly: true,
            minScore: 0,
            sources: ["sessions"],
          });
          expect(hits).toContainEqual(expect.objectContaining({ source: "sessions" }));
          expect(hits[0]?.snippet).not.toContain("\u0000");
        }
      }),
  );
});
