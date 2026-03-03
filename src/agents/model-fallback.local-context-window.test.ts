import { describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "./model-fallback.js";

describe("runWithModelFallback (local context too small)", () => {
  it("falls back when local model fails with n_keep >= n_ctx startup error", async () => {
    const run = vi
      .fn<Parameters<(provider: string, model: string) => Promise<string>>, Promise<string>>()
      .mockRejectedValueOnce(
        new Error("cannot truncate prompt with n_keep (13575) >= n_ctx (4096)"),
      )
      .mockResolvedValueOnce("ok");

    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "lmstudio",
      model: "qwen2.5-14b-instruct",
      fallbacksOverride: ["anthropic/claude-sonnet-4-5"],
      run,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(run.mock.calls).toEqual([
      ["lmstudio", "qwen2.5-14b-instruct"],
      ["anthropic", "claude-sonnet-4-5"],
    ]);
  });
});
