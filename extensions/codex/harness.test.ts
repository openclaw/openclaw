// Codex tests cover harness plugin behavior.
import { describe, expect, it } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
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

  it("delegates locked-session execution only to the voice-call plugin", () => {
    expect(harness.delegatedExecutionPluginIds).toEqual(["voice-call"]);
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
      providerIds: ["codex"],
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = narrowHarness.supports({ provider: "openai", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
  });

  it("exposes the fail-closed exact runtime artifact validator", async () => {
    if (!harness.runtimeArtifact) {
      throw new Error("expected Codex runtime artifact capability");
    }
    await expect(
      harness.runtimeArtifact.validate({
        id: "codex-app-server:v1:malformed",
        fingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });
});

describe("Codex agent harness reset()", () => {
  it("retires the physical session generation", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
    });
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    if (!harness.reset) {
      throw new Error("expected Codex harness reset hook");
    }

    await harness.reset({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      reason: "reset",
    });

    await expect(bindingStore.read(identity)).resolves.toBeUndefined();
  });
});
