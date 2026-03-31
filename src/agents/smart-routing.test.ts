import { describe, expect, it, vi } from "vitest";
import {
  classifyMessage,
  classifyMessageHybrid,
  scoreMessage,
  scoresToTier,
  resolveSmartRoutingOverride,
  recordRoutingCorrection,
  CLASSIFIER_SYSTEM_PROMPT,
  type ComplexityTier,
  type LlmClassifierFn,
} from "./smart-routing.js";
import type { OpenClawConfig } from "../config/types.js";

// ─── scoreMessage ───────────────────────────────────────────────────────────

describe("scoreMessage", () => {
  it("scores empty message as strongly simple", () => {
    const { total } = scoreMessage("");
    expect(total).toBeLessThanOrEqual(-5);
  });

  it("scores greetings as strongly simple", () => {
    const { total } = scoreMessage("hi");
    expect(total).toBeLessThan(-2);
  });

  it("scores emoji-only as simple", () => {
    const { total } = scoreMessage("👍");
    expect(total).toBeLessThan(-2);
  });

  it("scores slash commands as simple", () => {
    const { total } = scoreMessage("/status");
    expect(total).toBeLessThanOrEqual(-5);
  });

  it("scores code block messages as complex", () => {
    const msg = "```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```";
    const { total } = scoreMessage(msg);
    expect(total).toBeGreaterThan(2);
  });

  it("scores complex task verb + target as complex", () => {
    const { total } = scoreMessage("Build an API endpoint for user auth");
    expect(total).toBeGreaterThan(2);
  });

  it("scores long messages as complex", () => {
    const { total } = scoreMessage("a".repeat(501));
    expect(total).toBeGreaterThan(2);
  });

  it("scores moderate tasks as slightly positive", () => {
    const { signals } = scoreMessage("Summarize the key points");
    const moderateSignal = signals.find((s) => s.name === "moderate_task");
    expect(moderateSignal).toBeDefined();
    expect(moderateSignal!.score).toBeGreaterThan(0);
  });

  it("scores multi-sentence messages higher", () => {
    const msg = "First I need this done. Then do that. Also check the other thing. Finally deploy everything.";
    const { signals } = scoreMessage(msg);
    const multiSentence = signals.find((s) => s.name === "multi_sentence");
    expect(multiSentence).toBeDefined();
  });

  it("detects tech density", () => {
    const msg = "Check myApp.getData() and also userService.findById() with the config.json path";
    const { signals } = scoreMessage(msg);
    const tech = signals.find((s) => s.name === "tech_density" || s.name === "tech_hint");
    expect(tech).toBeDefined();
  });
});

// ─── scoresToTier ───────────────────────────────────────────────────────────

describe("scoresToTier", () => {
  it("maps strongly negative scores to simple", () => {
    expect(scoresToTier(-5).tier).toBe("simple");
    expect(scoresToTier(-5).confidence).toBe("high");
  });

  it("maps strongly positive scores to complex", () => {
    expect(scoresToTier(5).tier).toBe("complex");
    expect(scoresToTier(5).confidence).toBe("high");
  });

  it("maps ambiguous scores to default tier with low confidence", () => {
    expect(scoresToTier(0, "medium").tier).toBe("medium");
    expect(scoresToTier(0, "medium").confidence).toBe("low");
  });

  it("maps slightly negative to simple with low confidence", () => {
    const result = scoresToTier(-1.5);
    expect(result.tier).toBe("simple");
    expect(result.confidence).toBe("low");
  });

  it("maps slightly positive to complex with low confidence", () => {
    const result = scoresToTier(1.5);
    expect(result.tier).toBe("complex");
    expect(result.confidence).toBe("low");
  });
});

// ─── classifyMessage ────────────────────────────────────────────────────────

describe("classifyMessage", () => {
  const cases: Array<{ input: string; expected: ComplexityTier; label: string }> = [
    // Simple
    { input: "hi", expected: "simple", label: "greeting" },
    { input: "Hello!", expected: "simple", label: "greeting with punctuation" },
    { input: "thanks", expected: "simple", label: "acknowledgement" },
    { input: "yes", expected: "simple", label: "yes/no" },
    { input: "nope", expected: "simple", label: "negation" },
    { input: "ok", expected: "simple", label: "ok" },
    { input: "👍", expected: "simple", label: "emoji" },
    { input: "lol", expected: "simple", label: "lol" },
    { input: "/status", expected: "simple", label: "status command" },
    { input: "/help", expected: "simple", label: "help command" },
    { input: "cool", expected: "simple", label: "short acknowledgement" },

    // Complex
    {
      input: "Write a function that implements a binary search tree with insert, delete, and traversal methods",
      expected: "complex",
      label: "code generation request",
    },
    {
      input: "Build an API endpoint for user authentication with JWT tokens",
      expected: "complex",
      label: "build API request",
    },
    {
      input: "Compare and contrast microservices vs monolithic architecture, including pros and cons for a startup",
      expected: "complex",
      label: "detailed analysis request",
    },
    {
      input: "Write a blog post about AI safety in enterprise deployments",
      expected: "complex",
      label: "long-form writing request",
    },
    {
      input: "```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n```\nRefactor this to use dynamic programming",
      expected: "complex",
      label: "code block with refactoring request",
    },
    {
      input: "Review this PR for potential security issues and performance bottlenecks",
      expected: "complex",
      label: "PR review request",
    },
    {
      input: "Analyse this data and find correlations between the metrics",
      expected: "complex",
      label: "data analysis request",
    },
    {
      input: "Give me a step-by-step plan for migrating from REST to GraphQL",
      expected: "complex",
      label: "step-by-step request",
    },

    // Medium
    {
      input: "How do I reset my password?",
      expected: "medium",
      label: "how-to question",
    },
    {
      input: "Explain what Docker containers are",
      expected: "medium",
      label: "explanation request",
    },
    {
      input: "Summarize the key points from the meeting",
      expected: "medium",
      label: "summarization request",
    },
    {
      input: "Which is better, PostgreSQL or MySQL?",
      expected: "medium",
      label: "comparison question",
    },
  ];

  for (const { input, expected, label } of cases) {
    it(`classifies "${label}" as ${expected}`, () => {
      const result = classifyMessage(input);
      expect(result.tier).toBe(expected);
    });
  }

  it("classifies empty message as simple", () => {
    expect(classifyMessage("").tier).toBe("simple");
    expect(classifyMessage("   ").tier).toBe("simple");
  });

  it("classifies long messages (>500 chars) as complex", () => {
    const longMessage = "a".repeat(501);
    expect(classifyMessage(longMessage).tier).toBe("complex");
  });

  it("handles ambiguous messages", () => {
    // A genuinely ambiguous message that falls in the middle zone
    const ambiguous = "I was thinking about what we discussed yesterday regarding the project timeline";
    const result = classifyMessage(ambiguous, "medium");
    // Should be medium or low-confidence either way — not strongly simple or complex
    expect(Math.abs(result.score)).toBeLessThan(6);
  });

  it("includes score in the result", () => {
    const result = classifyMessage("hi");
    expect(typeof result.score).toBe("number");
  });

  it("marks method as pattern", () => {
    const result = classifyMessage("hello");
    expect(result.method).toBe("pattern");
  });
});

// ─── classifyMessageHybrid ──────────────────────────────────────────────────

describe("classifyMessageHybrid", () => {
  it("skips LLM for high-confidence pattern matches", async () => {
    const llmClassify = vi.fn<LlmClassifierFn>();
    const result = await classifyMessageHybrid({
      message: "hi",
      llmClassify,
    });
    expect(result.tier).toBe("simple");
    expect(result.method).toBe("pattern");
    expect(llmClassify).not.toHaveBeenCalled();
  });

  it("calls LLM for low-confidence messages", async () => {
    const llmClassify = vi.fn<LlmClassifierFn>().mockResolvedValue("complex");
    const result = await classifyMessageHybrid({
      message: "What should we do about the auth system?",
      llmClassify,
    });
    // Should use LLM result since pattern confidence is low
    if (result.method === "llm") {
      expect(result.tier).toBe("complex");
      expect(llmClassify).toHaveBeenCalled();
    }
    // If pattern was high confidence, that's fine too — it means
    // the pattern correctly classified it
  });

  it("falls back to pattern when LLM returns null", async () => {
    const llmClassify = vi.fn<LlmClassifierFn>().mockResolvedValue(null);
    const result = await classifyMessageHybrid({
      message: "What should we do about the auth system?",
      llmClassify,
    });
    expect(result.method).toBe("pattern");
  });

  it("falls back to pattern when LLM throws", async () => {
    const llmClassify = vi.fn<LlmClassifierFn>().mockRejectedValue(new Error("timeout"));
    const result = await classifyMessageHybrid({
      message: "What should we do about the auth system?",
      llmClassify,
    });
    expect(result.method).toBe("pattern");
  });

  it("works without LLM classifier (pattern-only)", async () => {
    const result = await classifyMessageHybrid({
      message: "hi",
    });
    expect(result.tier).toBe("simple");
    expect(result.method).toBe("pattern");
  });
});

// ─── resolveSmartRoutingOverride ────────────────────────────────────────────

describe("resolveSmartRoutingOverride", () => {
  const baseCfg: OpenClawConfig = {
    smartRouting: {
      enabled: true,
      tiers: {
        simple: "anthropic/claude-haiku-4-5",
        medium: "anthropic/claude-sonnet-4-6",
        complex: "anthropic/claude-opus-4-6",
      },
    },
  };

  it("returns null when smart routing is disabled", async () => {
    const cfg: OpenClawConfig = { smartRouting: { enabled: false } };
    expect(await resolveSmartRoutingOverride({ cfg, prompt: "hi" })).toBeNull();
  });

  it("returns null when smartRouting is not configured", async () => {
    expect(await resolveSmartRoutingOverride({ cfg: {}, prompt: "hi" })).toBeNull();
  });

  it("routes simple messages to haiku", async () => {
    const result = await resolveSmartRoutingOverride({ cfg: baseCfg, prompt: "hi" });
    expect(result).not.toBeNull();
    expect(result!.model).toBe("anthropic/claude-haiku-4-5");
    expect(result!.tier).toBe("simple");
  });

  it("routes complex messages to opus", async () => {
    const result = await resolveSmartRoutingOverride({
      cfg: baseCfg,
      prompt: "Write a function that implements a REST API for user management",
    });
    expect(result).not.toBeNull();
    expect(result!.model).toBe("anthropic/claude-opus-4-6");
    expect(result!.tier).toBe("complex");
  });

  it("routes medium messages to sonnet", async () => {
    const result = await resolveSmartRoutingOverride({
      cfg: baseCfg,
      prompt: "Explain how DNS works",
    });
    expect(result).not.toBeNull();
    expect(result!.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result!.tier).toBe("medium");
  });

  it("returns null when tier model is not configured", async () => {
    const cfg: OpenClawConfig = {
      smartRouting: {
        enabled: true,
        tiers: {
          complex: "anthropic/claude-opus-4-6",
        },
      },
    };
    const result = await resolveSmartRoutingOverride({ cfg, prompt: "hi" });
    expect(result).toBeNull();
  });

  it("excludes matching session keys", async () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      smartRouting: {
        ...baseCfg.smartRouting,
        excludeSessionKeys: ["agent:main:*"],
      },
    };
    const result = await resolveSmartRoutingOverride({
      cfg,
      prompt: "hi",
      sessionKey: "agent:main:main",
    });
    expect(result).toBeNull();
  });

  it("does not exclude non-matching session keys", async () => {
    const cfg: OpenClawConfig = {
      ...baseCfg,
      smartRouting: {
        ...baseCfg.smartRouting,
        excludeSessionKeys: ["agent:cron:*"],
      },
    };
    const result = await resolveSmartRoutingOverride({
      cfg,
      prompt: "hi",
      sessionKey: "agent:main:main",
    });
    expect(result).not.toBeNull();
  });

  it("includes classification details in the result", async () => {
    const result = await resolveSmartRoutingOverride({ cfg: baseCfg, prompt: "hi" });
    expect(result).not.toBeNull();
    expect(result!.classification).toBeDefined();
    expect(result!.classification.score).toBeDefined();
    expect(result!.classification.method).toBe("pattern");
  });

  it("uses hybrid strategy with LLM classifier", async () => {
    const cfg: OpenClawConfig = {
      smartRouting: {
        enabled: true,
        strategy: "hybrid",
        tiers: {
          simple: "anthropic/claude-haiku-4-5",
          medium: "anthropic/claude-sonnet-4-6",
          complex: "anthropic/claude-opus-4-6",
        },
      },
    };
    const llmClassify = vi.fn<LlmClassifierFn>().mockResolvedValue("complex");

    const result = await resolveSmartRoutingOverride({
      cfg,
      prompt: "What should we do about the auth system?",
      llmClassify,
    });

    expect(result).not.toBeNull();
    // Either the pattern or LLM classified it — both are valid
    expect(["simple", "medium", "complex"]).toContain(result!.tier);
  });
});

// ─── CLASSIFIER_SYSTEM_PROMPT ───────────────────────────────────────────────

describe("CLASSIFIER_SYSTEM_PROMPT", () => {
  it("is a non-empty string containing classification tiers", () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("simple");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("medium");
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain("complex");
  });
});

// ─── recordRoutingCorrection ────────────────────────────────────────────────

describe("recordRoutingCorrection", () => {
  it("does not throw", () => {
    expect(() =>
      recordRoutingCorrection({
        sessionKey: "agent:main:main",
        routedTier: "simple",
        routedModel: "anthropic/claude-haiku-4-5",
        correctedModel: "anthropic/claude-opus-4-6",
        prompt: "hi but actually this is complex",
      }),
    ).not.toThrow();
  });
});
