import { describe, expect, it, vi } from "vitest";
import { handleAutonomyLearnOpportunity } from "./autonomy-engine.js";

function makeRuntime() {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const cbrCases: Array<{ problem: string; solution: string; meta?: Record<string, unknown> }> = [];
  const rules: unknown[] = [];

  return {
    runtime: {
      kb: {
        ingest: vi.fn(async () => undefined),
      },
      cbrStore: {
        add: vi.fn((problem: string, solution: string, meta?: Record<string, unknown>) => {
          cbrCases.push({ problem, solution, meta });
          return { id: "cbr-1" };
        }),
        search: vi.fn(() => []),
      },
      ruleEngine: {
        addRule: vi.fn((_table: string, rule: unknown) => {
          rules.push(rule);
        }),
      },
      kernel: {
        publish: vi.fn(async (type: string, _source: string, payload: Record<string, unknown>) => {
          published.push({ type, payload });
        }),
      },
    },
    published,
    cbrCases,
    rules,
  };
}

describe("handleAutonomyLearnOpportunity", () => {
  it("writes KB/CBR and triggers evolution simulation on knowledge_gap", async () => {
    const { runtime, published, cbrCases } = makeRuntime();

    const result = await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "knowledge_gap",
      description: "24h 内多次兜底",
      metadata: { gap_type: "knowledge_gap", count: 6, last_input: "查一下产线 OEE" },
    });

    expect(runtime.kb.ingest).toHaveBeenCalled();
    expect(cbrCases.length).toBe(1);
    expect(result.actions_taken).toContain("evolution_simulation_requested");
    expect(published.some((e) => e.type === "evolution.simulation_requested")).toBe(true);
    expect(published.some((e) => e.type === "autonomy.learn_handled")).toBe(true);
  });

  it("adds im.quick_rules entry for negative_feedback with intent + sample text", async () => {
    const { runtime, rules } = makeRuntime();

    const result = await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "negative_feedback",
      description: "意图 order_status 连续负反馈",
      metadata: { intent: "order_status", last_input: "我的订单到哪了" },
    });

    expect(rules.length).toBe(1);
    expect(result.rules_added).toBe(1);
    expect(result.actions_taken).toContain("rule_added");
  });

  it("suggests CBR reuse when a similar success case exists", async () => {
    const { runtime, published } = makeRuntime();
    runtime.cbrStore.search = vi.fn(() => [
      {
        id: "case-99",
        outcome: "success",
        solution: "query_order_status",
      },
    ]);

    await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "stub_response",
      description: "兜底回复",
      metadata: { last_input: "订单进度", intent: "order_status" },
    });

    expect(published.some((e) => e.type === "autonomy.cbr_reuse_suggested")).toBe(true);
  });
});
