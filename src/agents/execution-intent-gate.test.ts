import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { detectExecutionIntentSignals, resolveExecutionGateMode } from "./execution-intent-gate.js";

describe("resolveExecutionGateMode", () => {
  it("defaults to off", () => {
    expect(resolveExecutionGateMode({ cfg: {} as OpenClawConfig, agentId: "main" })).toBe("off");
  });

  it("uses global defaults when no local override exists", () => {
    const cfg = {
      agents: {
        defaults: {
          executionGate: { mode: "warn" },
        },
      },
    } as OpenClawConfig;

    expect(resolveExecutionGateMode({ cfg, agentId: "main" })).toBe("warn");
  });

  it("uses per-agent override over global defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          executionGate: { mode: "warn" },
        },
        list: [
          {
            id: "main",
            executionGate: { mode: "enforce" },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveExecutionGateMode({ cfg, agentId: "main" })).toBe("enforce");
  });
});

describe("detectExecutionIntentSignals", () => {
  it("detects ack_without_execution when assistant commits but no execution artifacts exist", () => {
    const signals = detectExecutionIntentSignals({
      userPrompt: "continue linkedin parsing and report every 25 contacts",
      assistantTexts: ["Accepted. Starting now."],
    });

    expect(signals.ackWithoutExecution).toBe(true);
    expect(signals.commitmentSample).toContain("Starting");
  });

  it("does not flag ack_without_execution when execution artifacts exist", () => {
    const signals = detectExecutionIntentSignals({
      userPrompt: "continue linkedin parsing",
      assistantTexts: ["Accepted. Starting now."],
      hasToolMetas: true,
    });

    expect(signals.ackWithoutExecution).toBe(false);
  });

  it("detects pseudo tool call text lines", () => {
    const signals = detectExecutionIntentSignals({
      userPrompt: "read required files",
      assistantTexts: ['exec0({"cmd":"ls"})\nread:1(file: "AGENTS.md")'],
    });

    expect(signals.pseudoToolCallTextCount).toBe(2);
    expect(signals.pseudoToolCallSamples?.[0]).toContain("exec0");
  });

  it("does not flag non-action conversational turns", () => {
    const signals = detectExecutionIntentSignals({
      userPrompt: "what is your current model?",
      assistantTexts: ["I will answer briefly: openai-codex/gpt-5.3-codex."],
    });

    expect(signals.actionRequestLikely).toBe(false);
    expect(signals.ackWithoutExecution).toBe(false);
  });
});
