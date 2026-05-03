import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { buildDeveloperInstructions, resolveReasoningEffort } from "./thread-lifecycle.js";

function createAttemptParams(overrides: Partial<EmbeddedRunAttemptParams> = {}) {
  return {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    config: {},
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

describe("resolveReasoningEffort (#71946)", () => {
  describe("modern Codex models (none/low/medium/high/xhigh enum)", () => {
    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2"] as const)(
      "translates 'minimal' -> 'low' for %s so the first request is accepted",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("low");
      },
    );

    it.each(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2"] as const)(
      "passes 'low' / 'medium' / 'high' / 'xhigh' through unchanged for %s",
      (modelId) => {
        expect(resolveReasoningEffort("low", modelId)).toBe("low");
        expect(resolveReasoningEffort("medium", modelId)).toBe("medium");
        expect(resolveReasoningEffort("high", modelId)).toBe("high");
        expect(resolveReasoningEffort("xhigh", modelId)).toBe("xhigh");
      },
    );

    it("normalizes case-variant model ids", () => {
      expect(resolveReasoningEffort("minimal", "GPT-5.5")).toBe("low");
      expect(resolveReasoningEffort("minimal", " gpt-5.4-mini ")).toBe("low");
    });
  });

  describe("legacy / non-modern Codex models", () => {
    it.each(["gpt-5", "gpt-4o", "o3-mini", "codex-mini-latest"] as const)(
      "preserves 'minimal' for %s — pre-modern enum still supports it",
      (modelId) => {
        expect(resolveReasoningEffort("minimal", modelId)).toBe("minimal");
      },
    );

    it("preserves 'minimal' for empty / unknown model ids (conservative default)", () => {
      expect(resolveReasoningEffort("minimal", "")).toBe("minimal");
      expect(resolveReasoningEffort("minimal", "unknown-model-xyz")).toBe("minimal");
    });
  });

  describe("non-effort thinkLevel values", () => {
    it("returns null for 'off'", () => {
      expect(resolveReasoningEffort("off", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("off", "gpt-4o")).toBeNull();
    });

    it("returns null for 'adaptive' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("adaptive", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("adaptive", "gpt-4o")).toBeNull();
    });

    it("returns null for 'max' (non-effort enum value)", () => {
      expect(resolveReasoningEffort("max", "gpt-5.5")).toBeNull();
      expect(resolveReasoningEffort("max", "gpt-4o")).toBeNull();
    });
  });
});

describe("buildDeveloperInstructions", () => {
  it("tells same-session channel replies to answer normally", () => {
    const prompt = buildDeveloperInstructions(createAttemptParams());

    expect(prompt).toContain(
      "When replying in the current chat/session, answer normally and let OpenClaw handle delivery when normal final replies are enabled for that channel.",
    );
    expect(prompt).toContain(
      "If the turn says source channel delivery is private or message-tool-only, use the messaging tool for visible output.",
    );
    expect(prompt).not.toContain(
      "If sending a channel reply, use the OpenClaw messaging tool instead of describing that you would reply",
    );
  });
});
