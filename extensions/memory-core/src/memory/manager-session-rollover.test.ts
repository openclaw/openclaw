import { sessionPathForSessionIdentity } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory manager session rollover", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("keeps the previous transcript indexed after a session key rolls to a new session id", async () => {
    const sessionKey = "agent:main:main";
    const previousId = "rollover-previous";
    const currentId = "rollover-current";
    const seed = (sessionId: string, content: string, previousSessionId?: string) =>
      fixture.seedSessionTranscript({
        sessionId,
        sessionKey,
        ...(previousSessionId ? { previousSessionId } : {}),
        messages: [{ role: "user", timestamp: Date.now(), content, senderIsOwner: true }],
      });
    await seed(previousId, "The memory control word is ZAFFIRO927.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "cli", force: true });
    expect(manager.status().sourceCounts).toMatchObject([{ source: "sessions", files: 1 }]);

    // A daily or idle reset moves the key to a new session id that records the
    // previous one; the old transcript stays retained in SQLite.
    await seed(currentId, "Hello again after the reset.", previousId);
    await manager.sync({ reason: "cli", force: true });

    expect(manager.status().sourceCounts).toMatchObject([
      { source: "sessions", files: 2, chunks: 2 },
    ]);
    expect(await manager.search("ZAFFIRO927", { lexicalOnly: true, minScore: 0 })).toContainEqual(
      expect.objectContaining({
        path: sessionPathForSessionIdentity("main", previousId),
        snippet: expect.stringContaining("ZAFFIRO927"),
      }),
    );
  });
});
