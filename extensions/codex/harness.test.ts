import { describe, expect, it } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";

describe("Codex agent harness supports()", () => {
  const harness = createCodexAppServerAgentHarness();

  it("supports the canonical codex virtual provider", () => {
    expect(harness.supports({ provider: "codex" })).toEqual({ supported: true, priority: 100 });
  });

  it("supports openai-codex as the primary OpenClaw routing id", () => {
    expect(harness.supports({ provider: "openai-codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports the canonical openai routing id (documented Codex path)", () => {
    expect(harness.supports({ provider: "openai" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("rejects providers Codex app-server cannot resolve from its own config", () => {
    const result = harness.supports({ provider: "9router" });
    expect(result.supported).toBe(false);
    expect(result.supported === false ? result.reason : "").toContain("codex");
  });

  it("normalizes provider casing", () => {
    expect(harness.supports({ provider: "OpenAI-Codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });
});
