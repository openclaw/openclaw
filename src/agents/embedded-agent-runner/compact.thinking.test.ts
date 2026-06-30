// Verifies compaction thinkingLevel precedence and config fallback.
// The production expression (compact.ts:637-638) is:
//   cfgThinkLevel = params.config?.agents?.defaults?.compaction?.thinkingLevel;
//   thinkLevel = params.thinkLevel ?? cfgThinkLevel ?? "off";
import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.shared.js";

/** Replicates the compactEmbeddedAgentSessionDirectOnce thinkLevel resolution. */
function resolveCompactionThinkLevel(
  paramsThinkLevel: ThinkLevel | undefined,
  config: { agents?: { defaults?: { compaction?: { thinkingLevel?: ThinkLevel } } } } | undefined,
): ThinkLevel {
  const cfgThinkLevel = config?.agents?.defaults?.compaction?.thinkingLevel;
  return paramsThinkLevel ?? cfgThinkLevel ?? "off";
}

describe("compaction thinkLevel precedence", () => {
  it("defaults to off when nothing is configured", () => {
    expect(resolveCompactionThinkLevel(undefined, undefined)).toBe("off");
    expect(resolveCompactionThinkLevel(undefined, {})).toBe("off");
    expect(resolveCompactionThinkLevel(undefined, { agents: { defaults: {} } })).toBe("off");
  });

  it("uses config compaction.thinkingLevel when params.thinkLevel is unset", () => {
    const config = {
      agents: {
        defaults: {
          compaction: { thinkingLevel: "low" as const },
        },
      },
    };
    expect(resolveCompactionThinkLevel(undefined, config)).toBe("low");
  });

  it("uses config compaction.thinkingLevel=off when params.thinkLevel is unset", () => {
    const config = {
      agents: {
        defaults: {
          compaction: { thinkingLevel: "off" as const },
        },
      },
    };
    expect(resolveCompactionThinkLevel(undefined, config)).toBe("off");
  });

  it("params.thinkLevel overrides config compaction.thinkingLevel", () => {
    const config = {
      agents: {
        defaults: {
          compaction: { thinkingLevel: "high" as const },
        },
      },
    };
    expect(resolveCompactionThinkLevel("off", config)).toBe("off");
    expect(resolveCompactionThinkLevel("low", config)).toBe("low");
    expect(resolveCompactionThinkLevel("adaptive", config)).toBe("adaptive");
  });

  it("params.thinkLevel overrides config even when config is off", () => {
    const config = {
      agents: {
        defaults: {
          compaction: { thinkingLevel: "off" as const },
        },
      },
    };
    expect(resolveCompactionThinkLevel("high", config)).toBe("high");
  });

  it("supports all valid ThinkLevel values from config", () => {
    const levels: ThinkLevel[] = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
    ];
    for (const level of levels) {
      const config = {
        agents: {
          defaults: {
            compaction: { thinkingLevel: level },
          },
        },
      };
      expect(resolveCompactionThinkLevel(undefined, config)).toBe(level);
    }
  });
});
