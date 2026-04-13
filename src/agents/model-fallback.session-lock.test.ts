import { describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "./model-fallback.js";

describe("runWithModelFallback session lock contention", () => {
  it("rethrows session file lock errors without trying fallback candidates", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("session file locked (timeout 10000ms): pid=41991 /tmp/test-session.jsonl.lock"),
      )
      .mockResolvedValueOnce("should-not-run");

    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "openai-codex",
        model: "gpt-5.4",
        fallbacksOverride: ["ollama/qwen3.5:35b"],
        run,
      }),
    ).rejects.toThrow(/session file locked/);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
