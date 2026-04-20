import { describe, expect, it } from "vitest";
import { dispatch, formatExplain, formatHealth, formatStats } from "./commands.js";
import { ROUTER_DEFAULTS } from "./config.js";
import type { StatsSummary } from "./stats.js";

const FAKE_SUMMARY: StatsSummary = {
  totalDecisions: 10,
  rejected: 1,
  escalated: 2,
  perAlias: [
    { alias: "speed", count: 6 },
    { alias: "workhorse", count: 3 },
  ],
  averageConfidence: 0.88,
  window: { startMs: 0, endMs: 1 },
};

describe("aj-router commands", () => {
  it("formats stats with per-alias percentages", () => {
    const text = formatStats(FAKE_SUMMARY);
    expect(text).toContain("Decisions: 10");
    expect(text).toContain("speed");
    expect(text).toContain("60.0%");
    expect(text).toContain("Escalations: 2");
  });

  it("formatStats handles the empty case gracefully", () => {
    const text = formatStats({
      ...FAKE_SUMMARY,
      totalDecisions: 0,
      perAlias: [],
      escalated: 0,
      rejected: 0,
    });
    expect(text).toMatch(/no routing decisions/);
  });

  it("formats health with auth status per alias", () => {
    const envReader = (name: string) => (name === "ANTHROPIC_API_KEY" ? "sk-test" : undefined);
    const text = formatHealth({ config: ROUTER_DEFAULTS, envReader });
    expect(text).toContain("speed");
    expect(text).toContain("[ok]");
  });

  it("explains a routing decision with a trail", () => {
    const text = formatExplain({
      config: ROUTER_DEFAULTS,
      prompt: "Classify this email as spam.",
    });
    expect(text).toContain("AJ ROUTER — EXPLAIN");
    expect(text).toContain("speed");
    expect(text).toMatch(/•/);
  });

  it("dispatch routes 'stats' subcommand through the loader", async () => {
    const text = await dispatch({
      config: ROUTER_DEFAULTS,
      args: "stats",
      statsLoader: async () => FAKE_SUMMARY,
    });
    expect(text).toContain("AJ ROUTER — LAST 7 DAYS");
  });

  it("dispatch handles unknown subcommand with usage hint", async () => {
    const text = await dispatch({
      config: ROUTER_DEFAULTS,
      args: "bogus",
    });
    expect(text).toMatch(/Unknown .* subcommand/);
  });

  it("dispatch requires a prompt for 'explain'", async () => {
    const text = await dispatch({
      config: ROUTER_DEFAULTS,
      args: "explain",
    });
    expect(text).toMatch(/Usage: \/router explain/);
  });
});
