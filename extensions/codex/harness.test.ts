// Codex tests cover harness plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import {
  createCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./src/app-server/session-binding.test-helpers.js";

describe("Codex agent harness supports()", () => {
  const harness = createCodexAppServerAgentHarness({
    bindingStore: testCodexAppServerBindingStore,
  });

  it("supports the canonical codex virtual provider", () => {
    expect(harness.supports({ provider: "codex", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports openai as the primary OpenClaw routing id", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports the canonical openai routing id (documented Codex path)", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("rejects providers Codex app-server cannot resolve from its own config", () => {
    const result = harness.supports({ provider: "9router", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
    expect(!result.supported ? (result.reason ?? "") : "").toContain("codex");
  });

  it("normalizes provider casing", () => {
    expect(harness.supports({ provider: "OpenAI", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("honors explicit provider id overrides", () => {
    const narrowHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      providerIds: ["codex"],
    });
    const result = narrowHarness.supports({ provider: "openai", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
  });
});

describe("Codex agent harness reset", () => {
  it("uses the host agent for global session keys", async () => {
    const bindingStore = createCodexTestBindingStore();
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    const identity = {
      kind: "session" as const,
      agentId: "work",
      sessionId: "session-1",
      sessionKey: "global",
    };
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-work", cwd: "/repo" },
    });

    await harness.reset?.({
      agentId: "work",
      sessionId: "session-1",
      sessionKey: "global",
      reason: "reset",
    });

    await expect(bindingStore.read(identity)).resolves.toBeUndefined();
    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/stale" },
      }),
    ).resolves.toBe(false);
    const nextIdentity = { ...identity, sessionId: "session-2" };
    await expect(
      bindingStore.mutate(nextIdentity, {
        kind: "set",
        binding: { threadId: "thread-next", cwd: "/next" },
      }),
    ).resolves.toBe(false);
    await expect(
      bindingStore.mutate(nextIdentity, {
        kind: "reclaim-generation",
        expectedPreviousSessionId: identity.sessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      bindingStore.mutate(nextIdentity, {
        kind: "set",
        binding: { threadId: "thread-next", cwd: "/next" },
      }),
    ).resolves.toBe(true);
    await expect(bindingStore.read(nextIdentity)).resolves.toMatchObject({
      threadId: "thread-next",
    });
  });

  it("accepts an absent binding but rejects a mismatched reset generation", async () => {
    const bindingStore = createCodexTestBindingStore();
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    };

    await expect(
      harness.reset?.({
        agentId: "main",
        sessionId: "missing-session",
        sessionKey: "agent:main:missing",
        reason: "reset",
      }),
    ).resolves.toBeUndefined();

    await bindingStore.mutate(current, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    await expect(
      harness.reset?.({
        agentId: "main",
        sessionId: "session-2",
        sessionKey: current.sessionKey,
        reason: "reset",
      }),
    ).rejects.toThrow("binding generation changed");
    await expect(bindingStore.read(current)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("reclaims a stale generation left while the Codex plugin was unavailable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-reset-"));
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "session-2",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    const bindingStore = createCodexTestBindingStore();
    const harness = createCodexAppServerAgentHarness({
      bindingStore,
      resolveConfig: () => ({ session: { store: storePath } }),
    });
    const stale = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey,
    };
    await bindingStore.mutate(stale, {
      kind: "set",
      binding: { threadId: "thread-stale", cwd: "/repo" },
    });

    await expect(
      harness.reset?.({
        agentId: "main",
        sessionId: "session-2",
        sessionKey,
        reason: "reset",
      }),
    ).resolves.toBeUndefined();

    const current = { ...stale, sessionId: "session-2" };
    await expect(bindingStore.read(current)).resolves.toBeUndefined();
    await expect(
      bindingStore.mutate(current, {
        kind: "set",
        binding: { threadId: "thread-delayed", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
    await fs.rm(stateDir, { recursive: true, force: true });
  });
});
