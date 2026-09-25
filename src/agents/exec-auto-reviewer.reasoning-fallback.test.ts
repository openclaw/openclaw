// Exec auto-reviewer reasoning-constraint fallback: reasoning-only endpoints
// reject requests sent without a reasoning level, so the reviewer retries once.
import { describe, expect, it, vi } from "vitest";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";

const input = {
  command: "git status",
  argv: ["git", "status"],
  resolvedPath: "/usr/bin/git",
  cwd: "/repo",
  envKeys: [],
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
};

const reasoningConstraintError = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "openrouter",
  model: "openai/gpt-oss-safeguard-20b",
  stopReason: "error",
  errorMessage: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
};

function createReviewer(
  complete: ReturnType<typeof vi.fn>,
  reviewer?: Parameters<typeof createModelExecAutoReviewer>[0]["reviewer"],
) {
  const prepare = vi.fn(async () => ({
    selection: {
      provider: "openrouter",
      modelId: "openai/gpt-oss-safeguard-20b",
      agentDir: "/agent",
    },
    model: {
      provider: "openrouter",
      id: "openai/gpt-oss-safeguard-20b",
      api: "openai-completions",
    },
    auth: { apiKey: "key", mode: "env" },
    [Symbol.asyncDispose]: async () => {},
  }));
  return createModelExecAutoReviewer({
    cfg: {},
    ...(reviewer ? { reviewer } : {}),
    deps: {
      acquireSimpleCompletionModelForAgent:
        prepare as unknown as typeof import("./simple-completion-runtime.js").acquireSimpleCompletionModelForAgent,
      completeWithPreparedSimpleCompletionModel:
        complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
    },
  });
}

describe("createModelExecAutoReviewer reasoning fallback", () => {
  it("retries once with minimal reasoning when the endpoint requires reasoning", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(reasoningConstraintError)
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({ decision: "allow", risk: "low", rationale: "read-only" }),
          },
        ],
      });

    await expect(createReviewer(complete)(input)).resolves.toEqual({
      decision: "allow-once",
      risk: "low",
      rationale: "read-only",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0]?.options).not.toHaveProperty("reasoning");
    expect(complete.mock.calls[1]?.[0]?.options).toMatchObject({ reasoning: "minimal" });
  });

  it("does not retry a reasoning-constraint failure more than once", async () => {
    const complete = vi.fn(async () => reasoningConstraintError);

    await expect(createReviewer(complete)(input)).resolves.toEqual({
      decision: "ask",
      risk: "unknown",
      rationale: `exec reviewer completion failed: ${reasoningConstraintError.errorMessage}`,
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not retry when a reviewer thinking level is configured", async () => {
    const complete = vi.fn(async () => reasoningConstraintError);

    await expect(createReviewer(complete, { thinking: "off" })(input)).resolves.toEqual({
      decision: "ask",
      risk: "unknown",
      rationale: `exec reviewer completion failed: ${reasoningConstraintError.errorMessage}`,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]?.options).toMatchObject({ reasoning: "off" });
  });
});
