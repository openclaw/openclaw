import { describe, expect, it } from "vitest";
import { CodexSessionGenerationNotCurrentError } from "./thread-lifecycle-errors.js";

describe("CodexSessionGenerationNotCurrentError", () => {
  it("keeps the stable prefix so existing callers and matchers still recognize it", () => {
    const error = new CodexSessionGenerationNotCurrentError({
      sessionId: "isolated-task-42",
      sessionKey: "tool:isolated-task",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CodexSessionGenerationNotCurrentError");
    expect(error.message).toContain(
      "Codex session generation is no longer current: isolated-task-42",
    );
  });

  it("guides embedded callers to omit sessionKey or reuse sessionId", () => {
    // Regression #108769: a stable sessionKey with a rotating sessionId used to fail
    // opaquely, so the message must name the offending key and both escape hatches.
    const error = new CodexSessionGenerationNotCurrentError({
      sessionId: "isolated-task-42",
      sessionKey: "tool:isolated-task",
    });
    expect(error.message).toContain('sessionKey "tool:isolated-task"');
    expect(error.message).toContain("omit sessionKey");
    expect(error.message).toContain("reuse the same sessionId");
  });

  it("omits key-specific guidance when no sessionKey is involved", () => {
    const error = new CodexSessionGenerationNotCurrentError({ sessionId: "isolated-task-42" });
    expect(error.message).toBe("Codex session generation is no longer current: isolated-task-42.");
    expect(error.message).not.toContain("sessionKey");
  });
});
