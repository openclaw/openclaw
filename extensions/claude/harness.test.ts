import { afterEach, describe, expect, it, vi } from "vitest";

// Spy on the shared-client pool module so we can assert exactly which pool
// key dispose() clears WITHOUT spawning a real bridge. The harness
// dynamic-imports this module, so the mock must be registered before the
// factory's dispose() runs (vi.mock is hoisted, so this is fine).
const clearSpy = vi.fn(async () => {});
vi.mock("./src/app-server/client.js", () => ({
  clearSharedClaudeAppServerClient: clearSpy,
}));

import { createClaudeAppServerAgentHarness } from "./harness.js";

/**
 * Regression guard for openclaw-91t: dispose() must clear ONLY the caller's
 * own pool slot, never the whole pool. With both extensions/claude and
 * extensions/glm-bridge registering a bridge harness, a keyless clear tore
 * down the sibling extension's live bridge process on reload/disable.
 */
describe("createClaudeAppServerAgentHarness dispose() pool-key scoping", () => {
  afterEach(() => {
    clearSpy.mockClear();
  });

  it("defaults to the anthropic pool slot for the Claude extension", async () => {
    const harness = createClaudeAppServerAgentHarness();
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:anthropic");
  });

  it("clears the zai pool slot for a glm-bridge-style harness", async () => {
    const harness = createClaudeAppServerAgentHarness({ providerIds: ["zai"] });
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:zai");
  });

  it("never clears the whole pool (keyless clear) — the openclaw-91t bug", async () => {
    const harness = createClaudeAppServerAgentHarness({ providerIds: ["zai"] });
    await harness.dispose?.();
    expect(clearSpy).not.toHaveBeenCalledWith(undefined);
    expect(clearSpy).not.toHaveBeenCalledWith();
  });

  it("honors an explicit poolKey override", async () => {
    const harness = createClaudeAppServerAgentHarness({
      providerIds: ["zai"],
      poolKey: "claude-bridge:custom",
    });
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:custom");
  });
});
