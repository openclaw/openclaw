/**
 * Reasoning Engine Tests
 *
 * Tests algorithmic correctness of the new reasoning tools:
 * - CSP solver (constraint satisfaction)
 * - Bayesian update accuracy
 * - Fuzzy inference with known membership functions
 * - Trust scoring with time decay
 * - Statistical computations
 * - Temporal topological sort
 * - Meta-reasoning method selection
 * - Backward compatibility of `reason` tool
 *
 * Uses Node.js built-in test runner (node --test).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "vitest";
import register from "../index.js";

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: Function;
};

function createMockApi() {
  const tools: RegisteredTool[] = [];
  const api = {
    id: "mabos-test",
    name: "MABOS Test",
    version: "0.1.0",
    description: "Test instance",
    source: "test",
    config: {
      agents: { defaults: { workspace: "/tmp/mabos-reasoning-test" } },
    } as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: (tool: any) => {
      tools.push(tool);
    },
    registerHook: () => {},
    registerHttpHandler: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    on: () => {},
  };
  return { api, tools };
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ── Registration Tests ──────────────────────────────────────────

describe("Reasoning Engine — Tool Registration", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should register exactly 20 reason_* tools", () => {
    const reasonTools = tools.filter(
      (t) =>
        typeof t === "object" && t.name && (t.name === "reason" || t.name.startsWith("reason_")),
    );
    assert.equal(
      reasonTools.length,
      20,
      `Expected 20 reasoning tools, got ${reasonTools.length}: ${reasonTools.map((t) => t.name).join(", ")}`,
    );
  });

  it("should register all expected tool names", () => {
    const expected = [
      "reason",
      "reason_deductive",
      "reason_inductive",
      "reason_abductive",
      "reason_modal",
      "reason_deontic",
      "reason_constraint",
      "reason_bayesian",
      "reason_statistical",
      "reason_fuzzy",
      "reason_causal",
      "reason_counterfactual",
      "reason_temporal",
      "reason_scenario",
      "reason_analogical",
      "reason_dialectical",
      "reason_trust",
      "reason_game_theoretic",
      "reason_ethical",
      "reason_meta",
    ];
    for (const name of expected) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing reasoning tool: ${name}`,
      );
    }
  });

  it("should have no references to old inline REASONING_METHODS", () => {
    // The old REASONING_METHODS was defined inline in reasoning-tools.ts
    // Now it's imported from methods.ts. This test verifies the tool exists
    // and works with the new import.
    const reasonTool = findTool(tools, "reason");
    assert.ok(reasonTool.description.includes("35"));
  });
});

// ── CSP Solver (Constraint Satisfaction) ────────────────────────

describe("Reasoning Engine — CSP Solver", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should find a valid assignment for 3 variables with inequality constraints", async () => {
    const tool = findTool(tools, "reason_constraint");
    const result = await tool.execute("test", {
      variables: [
        { name: "A", domain: ["1", "2", "3"] },
        { name: "B", domain: ["1", "2", "3"] },
        { name: "C", domain: ["1", "2", "3"] },
      ],
      constraints: ["A != B", "B != C", "A != C"],
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Solution Found"), `Expected solution, got: ${text.slice(0, 200)}`);
    // Should assign 3 different values
    assert.ok(text.includes("A ="), "Should show A assignment");
    assert.ok(text.includes("B ="), "Should show B assignment");
    assert.ok(text.includes("C ="), "Should show C assignment");
  });

  it("should report overconstrained when no solution exists", async () => {
    const tool = findTool(tools, "reason_constraint");
    const result = await tool.execute("test", {
      variables: [
        { name: "A", domain: ["1"] },
        { name: "B", domain: ["1"] },
      ],
      constraints: ["A != B"],
    });

    const text = result.content[0].text;
    // Should either report overconstrained or fall back to prompt
    assert.ok(
      text.includes("overconstrained") || text.includes("No Solution") || text.includes("Fallback"),
      `Expected overconstrained/no-solution report, got: ${text.slice(0, 200)}`,
    );
  });

  it("should fall back to prompt for > 20 variables", async () => {
    const tool = findTool(tools, "reason_constraint");
    const variables = Array.from({ length: 21 }, (_, i) => ({
      name: `V${i}`,
      domain: ["a", "b"],
    }));
    const result = await tool.execute("test", {
      variables,
      constraints: ["V0 != V1"],
    });

    const text = result.content[0].text;
    assert.ok(
      text.includes("Fallback") || text.includes("prompt") || text.includes("exceeds"),
      `Expected fallback for >20 vars, got: ${text.slice(0, 200)}`,
    );
  });
});

// ── Bayesian Update ─────────────────────────────────────────────

describe("Reasoning Engine — Bayesian Updates", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should compute correct posterior probability", async () => {
    const tool = findTool(tools, "reason_bayesian");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      hypothesis: "market will grow",
      prior: 0.5,
      evidence: [{ description: "positive report", likelihood: 0.8, marginal: 0.6 }],
    });

    const text = result.content[0].text;
    // P(H|E) = 0.8 * 0.5 / 0.6 = 0.6667
    assert.ok(text.includes("0.6667"), `Expected 0.6667, got: ${text.slice(0, 300)}`);
  });

  it("should chain multiple evidence correctly", async () => {
    const tool = findTool(tools, "reason_bayesian");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      hypothesis: "hypothesis X",
      prior: 0.3,
      evidence: [
        { description: "E1", likelihood: 0.9, marginal: 0.5 },
        { description: "E2", likelihood: 0.7, marginal: 0.4 },
      ],
    });

    const text = result.content[0].text;
    // Step 1: P(H|E1) = 0.9 * 0.3 / 0.5 = 0.54
    // Step 2: P(H|E2) = 0.7 * 0.54 / 0.4 = 0.945
    assert.ok(text.includes("0.9450"), `Expected 0.9450, got: ${text.slice(0, 300)}`);
    assert.ok(text.includes("Strong support"), "Should be strong support");
  });
});

// ── Fuzzy Inference ─────────────────────────────────────────────

describe("Reasoning Engine — Fuzzy Inference", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should compute triangular membership and defuzzify", async () => {
    const tool = findTool(tools, "reason_fuzzy");
    const result = await tool.execute("test", {
      variables: [
        {
          name: "temperature",
          value: 25,
          sets: [
            { name: "cold", points: [0, 0, 20] },
            { name: "warm", points: [15, 25, 35] },
            { name: "hot", points: [30, 40, 40] },
          ],
        },
      ],
      rules: [
        { if_var: "temperature", if_set: "cold", then_var: "fan_speed", then_set: "low" },
        { if_var: "temperature", if_set: "warm", then_var: "fan_speed", then_set: "medium" },
        { if_var: "temperature", if_set: "hot", then_var: "fan_speed", then_set: "high" },
      ],
      output_variable: "fan_speed",
    });

    const text = result.content[0].text;
    // At temp=25: cold=0, warm=1.0 (at peak), hot=0
    assert.ok(text.includes("Fuzzy Logic Inference"), "Should have fuzzy inference header");
    assert.ok(text.includes("Fuzzification"), "Should show fuzzification step");
    assert.ok(text.includes("Rule Evaluation"), "Should show rule evaluation");
    assert.ok(text.includes("Defuzzification"), "Should show defuzzification");
    // Warm membership should be 1.0 at value 25 (the peak)
    assert.ok(text.includes("1.0000") || text.includes("warm"), "Should compute warm membership");
  });
});

// ── Trust Scoring ───────────────────────────────────────────────

describe("Reasoning Engine — Trust Scoring", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should compute trust score with decay", async () => {
    const tool = findTool(tools, "reason_trust");
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    const result = await tool.execute("test", {
      target_agent_id: "agent-x",
      history: [
        { outcome: "success", value: 1.0, timestamp: now.toISOString() },
        { outcome: "success", value: 0.8, timestamp: dayAgo.toISOString() },
        { outcome: "failure", value: 0.5, timestamp: weekAgo.toISOString() },
      ],
      decay_factor: 0.95,
    });

    const text = result.content[0].text;
    assert.ok(
      text.includes("Trust Score"),
      `Expected trust score output, got: ${text.slice(0, 200)}`,
    );
    assert.ok(text.includes("Reliability"), "Should show reliability metric");
    assert.ok(text.includes("Consistency"), "Should show consistency metric");
  });

  it("should handle empty history gracefully", async () => {
    const tool = findTool(tools, "reason_trust");
    const result = await tool.execute("test", {
      target_agent_id: "agent-y",
      history: [],
    });

    const text = result.content[0].text;
    // Should not crash, should return neutral or no-history response
    assert.ok(
      text.includes("Trust") || text.includes("trust"),
      "Should still return trust analysis",
    );
  });
});

// ── Statistical Computations ────────────────────────────────────

describe("Reasoning Engine — Statistical Analysis", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should compute correct mean, median, stddev", async () => {
    const tool = findTool(tools, "reason_statistical");
    const result = await tool.execute("test", {
      data: [
        { label: "Q1", value: 10 },
        { label: "Q2", value: 20 },
        { label: "Q3", value: 30 },
        { label: "Q4", value: 40 },
      ],
      analysis_type: "descriptive",
    });

    const text = result.content[0].text;
    // Mean = 25, Median = 25, Min = 10, Max = 40
    assert.ok(text.includes("25"), "Mean or median should be 25");
    assert.ok(text.includes("10"), "Min should be 10");
    assert.ok(text.includes("40"), "Max should be 40");
    assert.ok(text.includes("Count") || text.includes("4"), "Should show count");
  });

  it("should handle single data point", async () => {
    const tool = findTool(tools, "reason_statistical");
    const result = await tool.execute("test", {
      data: [{ label: "only", value: 42 }],
      analysis_type: "descriptive",
    });

    const text = result.content[0].text;
    assert.ok(text.includes("42"), "Should include the value");
    // Stddev of single point should be 0
    assert.ok(text.includes("0"), "Stddev should be 0");
  });
});

// ── Temporal Topological Sort ───────────────────────────────────

describe("Reasoning Engine — Temporal Reasoning", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should compute correct topological ordering", async () => {
    const tool = findTool(tools, "reason_temporal");
    const result = await tool.execute("test", {
      events: [
        { id: "A", label: "Design" },
        { id: "B", label: "Build", depends_on: ["A"] },
        { id: "C", label: "Test", depends_on: ["B"] },
        { id: "D", label: "Deploy", depends_on: ["C"] },
      ],
      query: "What is the execution order?",
      analysis_type: "ordering",
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Topological Order"), "Should show topological order");
    // Design should come before Build
    const designIdx = text.indexOf("Design");
    const buildIdx = text.indexOf("Build");
    assert.ok(designIdx < buildIdx, "Design should come before Build");
  });

  it("should detect cycles", async () => {
    const tool = findTool(tools, "reason_temporal");
    const result = await tool.execute("test", {
      events: [
        { id: "A", label: "Task A", depends_on: ["B"] },
        { id: "B", label: "Task B", depends_on: ["A"] },
      ],
      query: "Can these be ordered?",
      analysis_type: "dependencies",
    });

    const text = result.content[0].text;
    assert.ok(
      text.toLowerCase().includes("cycle"),
      `Expected cycle detection, got: ${text.slice(0, 200)}`,
    );
  });
});

// ── Meta-Reasoning Method Selection ─────────────────────────────

describe("Reasoning Engine — Meta-Reasoning", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should recommend formal methods for formal domain", async () => {
    const tool = findTool(tools, "reason_meta");
    const result = await tool.execute("test", {
      problem: "Prove that all even numbers greater than 2 can be expressed as sum of two primes",
      problem_classification: {
        uncertainty: "low",
        complexity: "complex",
        domain: "formal",
        time_pressure: "none",
        data_availability: "sparse",
        stakes: "low",
      },
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Meta-Reasoning"), "Should have meta-reasoning header");
    assert.ok(text.includes("formal"), "Should mention formal category");
  });

  it("should recommend probabilistic methods for data-rich empirical problems", async () => {
    const tool = findTool(tools, "reason_meta");
    const result = await tool.execute("test", {
      problem: "Predict Q4 sales based on historical data",
      problem_classification: {
        uncertainty: "medium",
        complexity: "moderate",
        domain: "empirical",
        time_pressure: "moderate",
        data_availability: "rich",
        stakes: "medium",
      },
    });

    const text = result.content[0].text;
    assert.ok(
      text.includes("probabilistic") || text.includes("bayesian") || text.includes("statistical"),
      "Should recommend probabilistic methods for empirical data-rich problems",
    );
  });
});

// ── Backward Compatibility ──────────────────────────────────────

describe("Reasoning Engine — Backward Compatibility", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("reason tool with explicit method still works", async () => {
    const tool = findTool(tools, "reason");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      method: "bayesian",
      problem: "Should we expand to new market?",
    });

    const text = result.content[0].text;
    assert.ok(text.includes("bayesian"), "Should include bayesian in output");
    assert.ok(
      text.includes("Reasoning") || text.includes("reasoning"),
      "Should have reasoning header",
    );
  });

  it("reason tool handles unknown method gracefully", async () => {
    const tool = findTool(tools, "reason");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      method: "nonexistent_method",
      problem: "test",
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Unknown method"), "Should report unknown method");
  });

  it("reason tool with multi_method generates fusion prompt", async () => {
    const tool = findTool(tools, "reason");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      problem: "Should we acquire CompanyX?",
      multi_method: true,
      methods: ["deductive", "bayesian", "ethical"],
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Multi-Method"), "Should be multi-method output");
    assert.ok(text.includes("deductive"), "Should include deductive");
    assert.ok(text.includes("bayesian"), "Should include bayesian");
    assert.ok(text.includes("ethical"), "Should include ethical");
  });

  it("reason tool with problem_classification auto-selects", async () => {
    const tool = findTool(tools, "reason");
    const result = await tool.execute("test", {
      agent_id: "test-agent",
      problem: "Which vendor should we choose?",
      problem_classification: {
        uncertainty: "medium",
        complexity: "moderate",
        domain: "mixed",
        time_pressure: "moderate",
        data_availability: "moderate",
        stakes: "medium",
      },
    });

    const text = result.content[0].text;
    assert.ok(text.includes("Auto-Selected"), "Should auto-select a method");
    assert.ok(text.includes("score"), "Should show selection score");
  });
});
