import { describe, expect, it } from "vitest";
import type { AgentCompactionConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
  DEFAULT_PREEMPTIVE_OVERFLOW_RATIO,
  resolveMaxOverflowCompactionAttempts,
  resolvePreemptiveOverflowRatio,
} from "./compaction-runtime-config.js";

function cfg(compaction: AgentCompactionConfig): OpenClawConfig {
  return { agents: { defaults: { compaction } } };
}

describe("Pi compaction runtime config", () => {
  it("uses defaults when overflow knobs are unset", () => {
    expect(resolveMaxOverflowCompactionAttempts()).toBe(DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS);
    expect(resolvePreemptiveOverflowRatio()).toBe(DEFAULT_PREEMPTIVE_OVERFLOW_RATIO);
  });

  it("resolves configured overflow compaction attempts", () => {
    expect(resolveMaxOverflowCompactionAttempts(cfg({ maxOverflowAttempts: 1 }))).toBe(1);
    expect(resolveMaxOverflowCompactionAttempts(cfg({ maxOverflowAttempts: 0 }))).toBe(0);
    expect(resolveMaxOverflowCompactionAttempts(cfg({ maxOverflowAttempts: 2.9 }))).toBe(2);
  });

  it("falls back for invalid overflow compaction attempts", () => {
    expect(resolveMaxOverflowCompactionAttempts(cfg({ maxOverflowAttempts: -1 }))).toBe(
      DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS,
    );
  });

  it("resolves configured preemptive overflow ratio", () => {
    expect(resolvePreemptiveOverflowRatio(cfg({ preemptiveOverflowRatio: 0.7 }))).toBe(0.7);
  });

  it("falls back for invalid preemptive overflow ratio values", () => {
    expect(resolvePreemptiveOverflowRatio(cfg({ preemptiveOverflowRatio: 0 }))).toBe(
      DEFAULT_PREEMPTIVE_OVERFLOW_RATIO,
    );
    expect(resolvePreemptiveOverflowRatio(cfg({ preemptiveOverflowRatio: 1 }))).toBe(
      DEFAULT_PREEMPTIVE_OVERFLOW_RATIO,
    );
  });
});
