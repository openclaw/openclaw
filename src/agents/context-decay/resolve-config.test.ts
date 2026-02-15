import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import { resolveContextDecayConfig, isContextDecayActive } from "./resolve-config.js";

function makeConfig(overrides: {
  defaults?: ContextDecayConfig;
  channels?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        contextDecay: overrides.defaults,
      },
    },
    channels: overrides.channels,
  } as OpenClawConfig;
}

describe("resolveContextDecayConfig", () => {
  it("returns undefined when config is undefined", () => {
    expect(resolveContextDecayConfig("discord:direct:123", undefined)).toBeUndefined();
  });

  it("returns undefined when no contextDecay is configured anywhere", () => {
    const config = {} as OpenClawConfig;
    expect(resolveContextDecayConfig("discord:direct:123", config)).toBeUndefined();
  });

  it("returns global defaults when no session key", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3 },
    });
    expect(resolveContextDecayConfig(undefined, config)).toEqual({
      stripThinkingAfterTurns: 3,
    });
  });

  it("returns global defaults when session key has no channel match", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3, maxContextMessages: 50 },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result).toEqual({
      stripThinkingAfterTurns: 3,
      maxContextMessages: 50,
    });
  });

  it("per-account overrides global defaults", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3, maxContextMessages: 50 },
      channels: {
        discord: {
          contextDecay: { stripThinkingAfterTurns: 5 },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result?.stripThinkingAfterTurns).toBe(5);
    expect(result?.maxContextMessages).toBe(50); // inherited from global
  });

  it("per-DM overrides per-account and global", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3, maxContextMessages: 50 },
      channels: {
        telegram: {
          contextDecay: { stripThinkingAfterTurns: 5 },
          dms: {
            "456": {
              contextDecay: { stripThinkingAfterTurns: 10, stripToolResultsAfterTurns: 7 },
            },
          },
        },
      },
    });
    const result = resolveContextDecayConfig("telegram:direct:456", config);
    expect(result?.stripThinkingAfterTurns).toBe(10); // DM override
    expect(result?.stripToolResultsAfterTurns).toBe(7); // DM-specific
    expect(result?.maxContextMessages).toBe(50); // inherited from global
  });

  it("DM override does not apply to non-direct session keys", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3 },
      channels: {
        discord: {
          dms: {
            "123": {
              contextDecay: { stripThinkingAfterTurns: 99 },
            },
          },
        },
      },
    });
    // Group session key, not "direct" or "dm"
    const result = resolveContextDecayConfig("discord:group:123", config);
    expect(result?.stripThinkingAfterTurns).toBe(3); // global only
  });

  it("handles agent-prefixed session keys", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3 },
      channels: {
        whatsapp: {
          contextDecay: { stripThinkingAfterTurns: 8 },
        },
      },
    });
    const result = resolveContextDecayConfig("agent:myagent:whatsapp:direct:+1234", config);
    expect(result?.stripThinkingAfterTurns).toBe(8);
  });

  it("treats N=0 as disabled (not merged)", () => {
    // Note: ContextDecaySchema uses z.number().int().positive() which rejects 0
    // at parse time. This test documents the defensive behavior of mergeDecayConfig
    // for any programmatic callers that bypass Zod validation.
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3, maxContextMessages: 50 },
      channels: {
        discord: {
          contextDecay: { stripThinkingAfterTurns: 0 }, // 0 = disabled
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    // 0 is not >= 1, so global value (3) persists
    expect(result?.stripThinkingAfterTurns).toBe(3);
  });

  it("returns config even when only summarizationModel is set (isContextDecayActive gates activation)", () => {
    const config = makeConfig({
      defaults: { summarizationModel: "haiku" }, // model alone doesn't activate
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    // resolveContextDecayConfig returns the merged config; callers use isContextDecayActive to gate
    expect(result).toEqual({ summarizationModel: "haiku" });
  });

  it("strips thread suffix from userId", () => {
    const config = makeConfig({
      defaults: { stripThinkingAfterTurns: 3 },
      channels: {
        telegram: {
          dms: {
            "789": {
              contextDecay: { stripThinkingAfterTurns: 20 },
            },
          },
        },
      },
    });
    const result = resolveContextDecayConfig("telegram:direct:789:thread:42", config);
    expect(result?.stripThinkingAfterTurns).toBe(20);
  });
});

describe("isContextDecayActive", () => {
  it("returns false for undefined", () => {
    expect(isContextDecayActive(undefined)).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(isContextDecayActive({})).toBe(false);
  });

  it("returns true when stripThinkingAfterTurns is set", () => {
    expect(isContextDecayActive({ stripThinkingAfterTurns: 2 })).toBe(true);
  });

  it("returns true when maxContextMessages is set", () => {
    expect(isContextDecayActive({ maxContextMessages: 100 })).toBe(true);
  });

  it("returns true when summarizeToolResultsAfterTurns is set", () => {
    expect(isContextDecayActive({ summarizeToolResultsAfterTurns: 3 })).toBe(true);
  });

  it("returns true when stripToolResultsAfterTurns is set", () => {
    expect(isContextDecayActive({ stripToolResultsAfterTurns: 5 })).toBe(true);
  });

  it("returns false when all numeric fields are 0", () => {
    expect(
      isContextDecayActive({
        stripThinkingAfterTurns: 0,
        summarizeToolResultsAfterTurns: 0,
        stripToolResultsAfterTurns: 0,
        maxContextMessages: 0,
      }),
    ).toBe(false);
  });

  it("returns false when only summarizationModel is set", () => {
    expect(isContextDecayActive({ summarizationModel: "haiku" })).toBe(false);
  });

  it("returns true when summarizeWindowAfterTurns is set", () => {
    expect(isContextDecayActive({ summarizeWindowAfterTurns: 6 })).toBe(true);
  });

  it("returns false when only groupSummarizationModel is set", () => {
    expect(isContextDecayActive({ groupSummarizationModel: "sonnet" })).toBe(false);
  });
});

describe("mergeDecayConfig — new group fields", () => {
  it("merges summarizeWindowAfterTurns from global", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6, summarizeWindowSize: 3 },
    });
    const result = resolveContextDecayConfig(undefined, config);
    expect(result?.summarizeWindowAfterTurns).toBe(6);
    expect(result?.summarizeWindowSize).toBe(3);
  });

  it("per-account overrides summarizeWindowAfterTurns", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6, summarizeWindowSize: 4 },
      channels: {
        discord: {
          contextDecay: { summarizeWindowAfterTurns: 10 },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result?.summarizeWindowAfterTurns).toBe(10);
    expect(result?.summarizeWindowSize).toBe(4); // inherited from global
  });

  it("merges groupSummarizationModel", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6, groupSummarizationModel: "sonnet" },
    });
    const result = resolveContextDecayConfig(undefined, config);
    expect(result?.groupSummarizationModel).toBe("sonnet");
  });

  it("override groupSummarizationModel takes precedence", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6, groupSummarizationModel: "haiku" },
      channels: {
        discord: {
          contextDecay: { groupSummarizationModel: "opus" },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result?.groupSummarizationModel).toBe("opus");
  });

  it("returns undefined when channel provides only groupSummarizationModel (no activation field)", () => {
    const config = makeConfig({
      channels: {
        discord: {
          contextDecay: { groupSummarizationModel: "sonnet" },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    // Model-only config has no numeric activation fields, so mergeDecayConfig
    // returns undefined (hasAnything check filters it out).
    expect(result).toBeUndefined();
  });

  it("preserves groupSummarizationModel when merged with an activation field", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6 },
      channels: {
        discord: {
          contextDecay: { groupSummarizationModel: "sonnet" },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result?.summarizeWindowAfterTurns).toBe(6);
    expect(result?.groupSummarizationModel).toBe("sonnet");
  });

  it("auto-clamps stripToolResultsAfterTurns when <= summarizeToolResultsAfterTurns", () => {
    const config = makeConfig({
      defaults: {
        summarizeToolResultsAfterTurns: 5,
        stripToolResultsAfterTurns: 3, // strip < summarize — misconfigured
      },
    });
    const result = resolveContextDecayConfig(undefined, config);
    // Should be auto-clamped to summarize + 1 = 6
    expect(result?.stripToolResultsAfterTurns).toBe(6);
    expect(result?.summarizeToolResultsAfterTurns).toBe(5);
  });

  it("does not clamp strip vs summarizeWindowAfterTurns (group summarizer reads raw transcript)", () => {
    const config = makeConfig({
      defaults: {
        summarizeWindowAfterTurns: 8,
        stripToolResultsAfterTurns: 5, // strip < groupSummarize — intentional, group reads raw
      },
    });
    const result = resolveContextDecayConfig(undefined, config);
    // NOT clamped — group summarizer reads raw snapshot, not the decayed view
    expect(result?.stripToolResultsAfterTurns).toBe(5);
    expect(result?.summarizeWindowAfterTurns).toBe(8);
  });

  it("only clamps strip against individual summarize, not group", () => {
    const config = makeConfig({
      defaults: {
        summarizeToolResultsAfterTurns: 4,
        summarizeWindowAfterTurns: 7,
        stripToolResultsAfterTurns: 3, // below both, but only individual matters
      },
    });
    const result = resolveContextDecayConfig(undefined, config);
    // Clamped to individual summarize + 1 = 5, NOT max(4, 7) + 1 = 8
    expect(result?.stripToolResultsAfterTurns).toBe(5);
  });

  it("does not clamp stripToolResultsAfterTurns when already above summarization thresholds", () => {
    const config = makeConfig({
      defaults: {
        summarizeToolResultsAfterTurns: 3,
        summarizeWindowAfterTurns: 6,
        stripToolResultsAfterTurns: 10, // already above both
      },
    });
    const result = resolveContextDecayConfig(undefined, config);
    expect(result?.stripToolResultsAfterTurns).toBe(10); // unchanged
  });

  it("auto-clamps when strip equals summarize (edge case)", () => {
    const config = makeConfig({
      defaults: {
        summarizeToolResultsAfterTurns: 5,
        stripToolResultsAfterTurns: 5, // equal — summaries would never display
      },
    });
    const result = resolveContextDecayConfig(undefined, config);
    expect(result?.stripToolResultsAfterTurns).toBe(6);
  });

  it("treats summarizeWindowAfterTurns=0 as disabled", () => {
    const config = makeConfig({
      defaults: { summarizeWindowAfterTurns: 6 },
      channels: {
        discord: {
          contextDecay: { summarizeWindowAfterTurns: 0 },
        },
      },
    });
    const result = resolveContextDecayConfig("discord:direct:123", config);
    expect(result?.summarizeWindowAfterTurns).toBe(6);
  });
});
