import { describe, expect, it, vi } from "vitest";

const { loadEmbeddedAttemptContextEngineHelpers } = vi.hoisted(() => ({
  loadEmbeddedAttemptContextEngineHelpers: vi.fn(),
}));

vi.mock(
  "../embedded-agent-runner/run/attempt.context-engine-helpers.js",
  async (importOriginal) => {
    loadEmbeddedAttemptContextEngineHelpers();
    return await importOriginal();
  },
);

describe("CLI bootstrap context import boundary", () => {
  it("does not load embedded attempt lifecycle helpers", async () => {
    await import("./bootstrap-context.js");

    expect(loadEmbeddedAttemptContextEngineHelpers).not.toHaveBeenCalled();
  });
});
