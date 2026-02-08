import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Test that sessions.patch model is correctly read by agentCommand
describe("sessions_spawn model e2e", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
    storePath = path.join(testDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("sessions.patch model is visible in subsequent loadSessionStore calls", async () => {
    // Dynamically import to avoid module initialization issues
    const { loadSessionStore, updateSessionStore } = await import("../config/sessions/store.js");
    const { clearSessionStoreCacheForTest } = await import("../config/sessions/store.js");

    clearSessionStoreCacheForTest();

    const sessionKey = `agent:main:subagent:${randomUUID()}`;
    const testModel = "google-antigravity/gemini-3-pro";

    // Step 1: Simulate sessions.patch writing model override
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        modelOverride: testModel,
        providerOverride: "google-antigravity",
      };
    });

    // Step 2: Simulate agent handler reading the session (like loadSessionEntry does)
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];

    // Verify the model override is visible
    expect(entry).toBeDefined();
    expect(entry?.modelOverride).toBe(testModel);
    expect(entry?.providerOverride).toBe("google-antigravity");
  });

  it("model override survives through session update cycle", async () => {
    const { loadSessionStore, updateSessionStore } = await import("../config/sessions/store.js");
    const { clearSessionStoreCacheForTest } = await import("../config/sessions/store.js");

    clearSessionStoreCacheForTest();

    const sessionKey = `agent:main:subagent:${randomUUID()}`;
    const testModel = "google-antigravity/gemini-3-pro";

    // Step 1: Write initial entry with model override (like sessions.patch)
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        modelOverride: testModel,
        providerOverride: "google-antigravity",
      };
    });

    // Step 2: Read and update (like agent handler does)
    loadSessionStore(storePath);

    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey];
      store[sessionKey] = {
        ...existing,
        sessionId: existing?.sessionId ?? randomUUID(),
        updatedAt: Date.now(),
        // This is how agent handler copies model override
        modelOverride: existing?.modelOverride,
        providerOverride: existing?.providerOverride,
        // Add some other fields
        thinkingLevel: "low",
      };
    });

    // Step 3: Read again (like agentCommand's resolveSession does)
    const store2 = loadSessionStore(storePath);
    const entry2 = store2[sessionKey];

    // Verify model override is still there
    expect(entry2).toBeDefined();
    expect(entry2?.modelOverride).toBe(testModel);
    expect(entry2?.providerOverride).toBe("google-antigravity");
    expect(entry2?.thinkingLevel).toBe("low");
  });
});
