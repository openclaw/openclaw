import { describe, expect, it, vi } from "vitest";
import { createAutonomyEngine, handleAutonomyLearnOpportunity } from "./autonomy-engine.js";

function makeRuntime(
  overrides: Partial<{
    hasLlm: boolean;
    cbrSearchHits: Array<{ id: string; outcome?: string; solution?: string }>;
  }> = {},
) {
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const cbrCases: Array<{ problem: string; solution: string; meta?: Record<string, unknown> }> = [];
  const rules: unknown[] = [];
  const hasLlm = overrides.hasLlm ?? true;

  const runtime = {
    kb: {
      ingest: vi.fn(async () => undefined),
    },
    capabilities: {
      list: () => [],
    },
    playbookEngine: {
      listPlaybooks: () => [],
    },
    loadedPacks: [],
    logger: vi.fn(),
    cbrStore: {
      add: vi.fn((problem: string, solution: string, meta?: Record<string, unknown>) => {
        cbrCases.push({ problem, solution, meta });
        return { id: "cbr-1" };
      }),
      search: vi.fn(() => overrides.cbrSearchHits ?? []),
    },
    ruleEngine: {
      addRule: vi.fn((_table: string, rule: unknown) => {
        rules.push(rule);
      }),
    },
    structuredOutput: hasLlm
      ? {
          complete: vi.fn(async () => ({
            data: {
              title: "自动草稿",
              description: "测试",
              playbook_yaml: "id: auto_draft\nsteps: []",
              required_capabilities: [],
              missing_capabilities: [],
              trigger_event: "user.custom_event",
              test_event: "user.custom_event",
              test_payload: {},
              confidence: 0.8,
              warnings: [],
            },
            fallback: false,
          })),
        }
      : undefined,
    kernel: {
      publish: vi.fn(async (type: string, _source: string, payload: Record<string, unknown>) => {
        published.push({ type, payload });
      }),
    },
  };

  return {
    runtime,
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

  it("proposes evolve draft on knowledge_gap when LLM is available", async () => {
    const { runtime, published } = makeRuntime({ hasLlm: true });

    const result = await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "knowledge_gap",
      description: "24h 内多次兜底",
      metadata: { gap_type: "knowledge_gap", count: 6, last_input: "查一下产线 OEE" },
    });

    expect(result.actions_taken).toContain("evolve_draft_proposed");
    expect(published.some((e) => e.type === "evolve.playbook_drafted")).toBe(true);
    expect(runtime.kb.ingest).toHaveBeenCalledTimes(2);
  });

  it("skips evolve draft when LLM bridge is unavailable", async () => {
    const { runtime, published } = makeRuntime({ hasLlm: false });

    const result = await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "knowledge_gap",
      description: "24h 内多次兜底",
      metadata: { last_input: "查一下产线 OEE" },
    });

    expect(result.actions_taken).not.toContain("evolve_draft_proposed");
    expect(published.some((e) => e.type === "evolve.playbook_drafted")).toBe(false);
  });
});

describe("createAutonomyEngine", () => {
  it("exportLearningData 委托 evolutionSync.exportEvolutionData", async () => {
    const exportData = { robot_id: "r1", exported_at: "2026-01-01", days: 7 };
    const runtime = {
      evolutionSync: {
        exportEvolutionData: vi.fn(async (days: number) => ({ ...exportData, days })),
      },
    };

    const engine = createAutonomyEngine(runtime as never);
    const data = await engine.exportLearningData(7);

    expect(runtime.evolutionSync.exportEvolutionData).toHaveBeenCalledWith(7);
    expect(data.robot_id).toBe("r1");
    expect(data.days).toBe(7);
  });

  it("exportLearningData 在 evolutionSync 缺失时抛错", async () => {
    const engine = createAutonomyEngine({} as never);
    await expect(engine.exportLearningData()).rejects.toThrow(/evolutionSync/);
  });
});
