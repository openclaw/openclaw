import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { sessionPathForSessionIdentity } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager session rollover", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const sessionKey = "agent:main:main";
  const sessionConfig = () =>
    fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true });
  // A daily or idle reset moves the key to a new session id that records the
  // previous one; the old transcript stays retained in SQLite.
  const seed = (sessionId: string, content: string, previousSessionId?: string) =>
    fixture.seedSessionTranscript({
      sessionId,
      sessionKey,
      ...(previousSessionId ? { previousSessionId } : {}),
      messages: [{ role: "user", timestamp: Date.now(), content, senderIsOwner: true }],
    });
  const expectHit = async (
    manager: Awaited<ReturnType<typeof fixture.getFreshManager>>,
    query: string,
    sessionId: string,
  ) => {
    expect(await manager.search(query, { lexicalOnly: true, minScore: 0 })).toContainEqual(
      expect.objectContaining({
        path: sessionPathForSessionIdentity("main", sessionId),
        snippet: expect.stringContaining(query),
      }),
    );
  };

  it("keeps the previous transcript indexed after a session key rolls to a new session id", async () => {
    const previousId = "rollover-previous";
    const currentId = "rollover-current";
    await seed(previousId, "The memory control word is ZAFFIRO927.");
    const manager = await fixture.getFreshManager(sessionConfig(), "cli");
    await manager.sync({ reason: "cli", force: true });
    expect(manager.status().sourceCounts).toMatchObject([{ source: "sessions", files: 1 }]);

    await seed(currentId, "Hello again after the reset.", previousId);
    await manager.sync({ reason: "cli", force: true });

    expect(manager.status().sourceCounts).toMatchObject([
      { source: "sessions", files: 2, chunks: 2 },
    ]);
    await expectHit(manager, "ZAFFIRO927", previousId);
  });

  it("keeps the previous transcript when a targeted sync addresses it after the rollover", async () => {
    const previousId = "rollover-targeted-previous";
    const currentId = "rollover-targeted-current";
    await seed(previousId, "The targeted control word is GRANATO314.");
    await seed(currentId, "Hello again after the reset.", previousId);
    const manager = await fixture.getFreshManager(sessionConfig(), "cli");
    await manager.sync({ reason: "cli", force: true });
    await expectHit(manager, "GRANATO314", previousId);

    // A transcript update queued before the rollover is processed after it.
    await manager.sync({
      reason: "session-delta",
      sessions: [{ agentId: "main", sessionId: previousId, sessionKey }],
    });

    expect(manager.status().sourceCounts).toMatchObject([{ source: "sessions", files: 2 }]);
    await expectHit(manager, "GRANATO314", previousId);
  });

  it("follows the lineage past a session that also has a reset archive", async () => {
    const firstId = "rollover-lineage-first";
    const middleId = "rollover-lineage-middle";
    const currentId = "rollover-lineage-current";
    await seed(firstId, "The lineage control word is AMBRA552.");
    await seed(middleId, "Middle generation after the first reset.", firstId);
    await seed(currentId, "Current generation after the second reset.", middleId);
    await fs.writeFile(
      path.join(
        resolveSessionTranscriptsDirForAgent("main"),
        `${middleId}.jsonl.reset.2026-10-01T00-00-00.000Z`,
      ),
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "Archived copy of the middle generation." },
      })}\n`,
    );
    const manager = await fixture.getFreshManager(sessionConfig(), "cli");
    await manager.sync({ reason: "cli", force: true });

    await expectHit(manager, "AMBRA552", firstId);
  });
});
