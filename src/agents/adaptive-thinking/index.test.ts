import { describe, expect, it, vi } from "vitest";
import {
  buildAdaptiveThinkingContextBundle,
  evaluateAdaptiveThinking,
  normalizeAdaptiveThinkingDecision,
  resolveAdaptiveThinking,
} from "./index.js";

describe("adaptive thinking", () => {
  it("normalizes valid decisions and dedupes signals", () => {
    const result = normalizeAdaptiveThinkingDecision({
      thinkingLevel: " high ",
      confidence: 1.2,
      reason: "careful",
      signals: ["debugging", "debugging", "tool_likely", "invalid"],
    });

    expect(result).toEqual({
      ok: true,
      decision: {
        thinkingLevel: "high",
        confidence: 1,
        reason: "careful",
        signals: ["debugging", "tool_likely"],
      },
    });
  });

  it("rejects invalid decisions", () => {
    expect(normalizeAdaptiveThinkingDecision(null)).toEqual({
      ok: false,
      reason: "decision must be an object",
    });
    expect(
      normalizeAdaptiveThinkingDecision({
        thinkingLevel: "banana",
        confidence: 0.5,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid thinkingLevel",
    });
    expect(
      normalizeAdaptiveThinkingDecision({
        thinkingLevel: "low",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid confidence",
    });
  });

  it("builds compact context signals from recent messages and attachments", () => {
    const bundle = buildAdaptiveThinkingContextBundle({
      currentMessage: "Please debug this failing test and propose an architecture plan",
      recentMessages: ["there is a stack trace", "the repo has a TypeScript API bug"],
      attachmentCount: 2,
      currentThinkingDefault: "low",
      recentMessagesLimit: 2,
    });

    expect(bundle.recentMessages).toEqual([
      "there is a stack trace",
      "the repo has a TypeScript API bug",
    ]);
    expect(bundle.signals).toEqual(
      expect.arrayContaining([
        "attachments",
        "debugging",
        "planning",
        "coding",
        "tool_likely",
        "multi_step",
      ]),
    );
  });

  it("falls back to lightweight off decision when no signals are present", async () => {
    const result = await evaluateAdaptiveThinking({
      bundle: buildAdaptiveThinkingContextBundle({
        currentMessage: "hello",
        currentThinkingDefault: "low",
      }),
    });

    expect(result).toEqual({
      kind: "decision",
      decision: {
        thinkingLevel: "off",
        confidence: 0.55,
        reason: "lightweight turn",
        signals: [],
      },
    });
  });

  it("uses adaptive result above confidence threshold", async () => {
    const logger = vi.fn();
    const result = await resolveAdaptiveThinking({
      cfg: { agents: { defaults: {} } },
      provider: "anthropic",
      model: "claude-opus-4-5",
      currentMessage: "debug this failing test in the repo",
      recentMessages: ["stack trace attached"],
      attachmentCount: 1,
      config: { enabled: true, confidenceThreshold: 0.8, recentMessages: 1 },
      logger,
    });

    expect(result).toMatchObject({
      thinkingLevel: "medium",
      source: "adaptive",
      confidence: 0.84,
    });
    expect(result.signals).toEqual(
      expect.arrayContaining(["attachments", "debugging", "tool_likely", "multi_step"]),
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("source=adaptive"));
  });

  it("falls back to thinking default below confidence threshold", async () => {
    const logger = vi.fn();
    const result = await resolveAdaptiveThinking({
      cfg: { agents: { defaults: { thinkingDefault: "high" } } },
      provider: "anthropic",
      model: "claude-opus-4-5",
      currentMessage: "please open this file",
      config: { enabled: true, confidenceThreshold: 0.95 },
      logger,
    });

    expect(result).toEqual({
      thinkingLevel: "high",
      source: "thinking_default",
    });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("reason=low_confidence"));
  });

  it("respects explicit and session override precedence before adaptive evaluation", async () => {
    const explicit = await resolveAdaptiveThinking({
      cfg: { agents: { defaults: { thinkingDefault: "low" } } },
      provider: "anthropic",
      model: "claude-opus-4-5",
      explicitOverride: "high",
      sessionOverride: "minimal",
      currentMessage: "debug this",
    });
    expect(explicit).toEqual({ thinkingLevel: "high", source: "explicit_override" });

    const session = await resolveAdaptiveThinking({
      cfg: { agents: { defaults: { thinkingDefault: "low" } } },
      provider: "anthropic",
      model: "claude-opus-4-5",
      sessionOverride: "minimal",
      currentMessage: "debug this",
    });
    expect(session).toEqual({ thinkingLevel: "minimal", source: "session_override" });
  });
});
