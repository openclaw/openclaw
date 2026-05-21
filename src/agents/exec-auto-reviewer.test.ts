import { describe, expect, it, vi } from "vitest";
import { createModelExecAutoReviewer, parseExecAutoReviewResponse } from "./exec-auto-reviewer.js";

const input = {
  command: "git status",
  argv: ["git", "status"],
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

describe("parseExecAutoReviewResponse", () => {
  it("parses strict JSON allow decisions", () => {
    expect(
      parseExecAutoReviewResponse(
        JSON.stringify({
          decision: "allow-once",
          risk: "low",
          rationale: "read-only inspection",
        }),
      ),
    ).toEqual({
      decision: "allow-once",
      risk: "low",
      rationale: "read-only inspection",
    });
  });

  it("normalizes unsupported or malformed decisions to human review", () => {
    expect(parseExecAutoReviewResponse("sure, run it")).toMatchObject({
      decision: "ask-human",
    });
    expect(
      parseExecAutoReviewResponse(
        JSON.stringify({
          decision: "allow-always",
          risk: "low",
          rationale: "cached",
        }),
      ),
    ).toMatchObject({
      decision: "ask-human",
      rationale: "exec reviewer returned an unsupported decision",
    });
  });

  it("requires allow decisions to carry low risk", () => {
    for (const risk of ["medium", "high", "unknown", undefined]) {
      expect(
        parseExecAutoReviewResponse(
          JSON.stringify({
            decision: "allow-once",
            risk,
            rationale: "looks fine",
          }),
        ),
      ).toEqual({
        decision: "ask-human",
        risk: risk ?? "unknown",
        rationale: "exec reviewer returned a non-low allow decision",
      });
    }
  });
});

describe("createModelExecAutoReviewer", () => {
  it("uses the configured exec reviewer model for review calls", async () => {
    const prepare = vi.fn(async () => ({
      selection: {
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-6",
        agentDir: "/agent",
      },
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4-6", api: "openai" },
      auth: { apiKey: "key", mode: "env" },
    }));
    const complete = vi.fn(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decision: "deny",
            risk: "high",
            rationale: "network exfiltration",
          }),
        },
      ],
    }));
    const reviewer = createModelExecAutoReviewer({
      cfg: {},
      agentId: "ops",
      reviewer: { model: { primary: "openrouter/anthropic/claude-sonnet-4-6" } },
      deps: {
        prepareSimpleCompletionModelForAgent:
          prepare as unknown as typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
        completeWithPreparedSimpleCompletionModel:
          complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
      },
    });

    await expect(reviewer(input)).resolves.toEqual({
      decision: "deny",
      risk: "high",
      rationale: "network exfiltration",
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        modelRef: "openrouter/anthropic/claude-sonnet-4-6",
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          systemPrompt: expect.stringContaining("SSH key material"),
        }),
        options: expect.objectContaining({
          temperature: 0,
        }),
      }),
    );
  });

  it("falls back to human approval when the model is unavailable", async () => {
    const reviewer = createModelExecAutoReviewer({
      cfg: {},
      deps: {
        prepareSimpleCompletionModelForAgent: vi.fn(async () => ({
          error: "missing API key",
        })) as unknown as typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
      },
    });

    await expect(reviewer(input)).resolves.toMatchObject({
      decision: "ask-human",
      rationale: "exec reviewer model unavailable: missing API key",
    });
  });

  it("applies the reviewer timeout while preparing the model", async () => {
    vi.useFakeTimers();
    try {
      const prepare = vi.fn(
        () =>
          new Promise<never>(() => {
            // Keep model preparation pending until the reviewer timeout wins.
          }),
      );
      const reviewer = createModelExecAutoReviewer({
        cfg: {},
        reviewer: { timeoutMs: 5_000 },
        deps: {
          prepareSimpleCompletionModelForAgent:
            prepare as unknown as typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
        },
      });

      let settled = false;
      const result = reviewer(input).then((decision) => {
        settled = true;
        return decision;
      });
      await vi.advanceTimersByTimeAsync(5_001);

      expect(settled).toBe(true);
      await expect(result).resolves.toMatchObject({
        decision: "ask-human",
        rationale: "exec reviewer timed out after 5000ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives reviewer completion a fresh timeout after slow model preparation", async () => {
    vi.useFakeTimers();
    try {
      const prepare = vi.fn(
        () =>
          new Promise<{
            selection: { provider: string; modelId: string; agentDir: string };
            model: { provider: string; id: string; api: "openai" };
            auth: { apiKey: string; mode: "env" };
          }>((resolve) => {
            setTimeout(() => {
              resolve({
                selection: {
                  provider: "openrouter",
                  modelId: "anthropic/claude-sonnet-4-6",
                  agentDir: "/agent",
                },
                model: { provider: "openrouter", id: "anthropic/claude-sonnet-4-6", api: "openai" },
                auth: { apiKey: "key", mode: "env" },
              });
            }, 4_900);
          }),
      );
      const complete = vi.fn(
        () =>
          new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
            setTimeout(() => {
              resolve({
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      decision: "allow-once",
                      risk: "low",
                      rationale: "read-only inspection",
                    }),
                  },
                ],
              });
            }, 2_000);
          }),
      );
      const reviewer = createModelExecAutoReviewer({
        cfg: {},
        reviewer: { timeoutMs: 5_000 },
        deps: {
          prepareSimpleCompletionModelForAgent:
            prepare as unknown as typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent,
          completeWithPreparedSimpleCompletionModel:
            complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
        },
      });

      const result = reviewer(input);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(complete).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(result).resolves.toEqual({
        decision: "allow-once",
        risk: "low",
        rationale: "read-only inspection",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
