/**
 * MABOS Plugin Tests
 *
 * Validates tool registration, ontology loading, and basic tool execution.
 * Uses Node.js built-in test runner (node --test).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "vitest";
import register from "../index.js";

// ── Mock OpenClawPluginApi ──

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: Function;
};

type RegisteredHook = {
  events: string | string[];
  handler: Function;
};

function createMockApi() {
  const tools: RegisteredTool[] = [];
  const hooks: RegisteredHook[] = [];
  const logs: string[] = [];

  const api = {
    id: "mabos-test",
    name: "MABOS Test",
    version: "0.1.0",
    description: "Test instance",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: "/tmp/mabos-test",
        },
      },
    } as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: {
      debug: (msg: string) => logs.push(`[debug] ${msg}`),
      info: (msg: string) => logs.push(`[info] ${msg}`),
      warn: (msg: string) => logs.push(`[warn] ${msg}`),
      error: (msg: string) => logs.push(`[error] ${msg}`),
    },
    registerTool: (tool: any) => {
      tools.push(tool);
    },
    registerHook: (events: any, handler: any) => {
      hooks.push({ events, handler });
    },
    registerHttpHandler: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    resolvePath: (p: string) => p,
    on: (hookName: string, handler: Function) => {
      hooks.push({ events: hookName, handler });
    },
  };

  return { api, tools, hooks, logs };
}

// ── Tests ──

describe("MABOS Plugin Registration", () => {
  let tools: RegisteredTool[];
  let hooks: RegisteredHook[];
  let logs: string[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
    hooks = mock.hooks;
    logs = mock.logs;
  });

  it("should register all tools", () => {
    // We expect 89 tools across 20 modules
    assert.ok(tools.length >= 80, `Expected at least 80 tools, got ${tools.length}`);
  });

  it("should log successful registration", () => {
    assert.ok(
      logs.some((l) => l.includes("MABOS extension registered")),
      "Should log success message",
    );
  });

  it("should register lifecycle hooks", () => {
    assert.ok(hooks.length >= 2, `Expected at least 2 hooks, got ${hooks.length}`);
    const hookNames = hooks.map((h) => h.events);
    assert.ok(hookNames.includes("before_agent_start"), "Should register before_agent_start hook");
    assert.ok(hookNames.includes("after_tool_call"), "Should register after_tool_call hook");
  });

  it("should have unique tool names", () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    assert.equal(
      names.length,
      uniqueNames.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`,
    );
  });

  it("should have labels on all tools", () => {
    // Filter out factory functions (from registerTool with factory pattern)
    const directTools = tools.filter((t) => typeof t === "object" && t.name);
    for (const tool of directTools) {
      assert.ok(tool.label, `Tool ${tool.name} missing label`);
    }
  });

  it("should have execute functions on all tools", () => {
    // Filter out factory functions (from registerTool with factory pattern)
    const directTools = tools.filter((t) => typeof t === "object" && t.name);
    for (const tool of directTools) {
      assert.equal(typeof tool.execute, "function", `Tool ${tool.name} missing execute function`);
    }
  });
});

describe("BDI Tools", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should register core BDI tools", () => {
    const bdiNames = [
      "belief_get",
      "belief_update",
      "goal_create",
      "goal_evaluate",
      "intention_commit",
      "bdi_cycle",
    ];
    for (const name of bdiNames) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing BDI tool: ${name}`,
      );
    }
  });

  it("should register desire tools", () => {
    const desireNames = ["desire_create", "desire_evaluate", "desire_drop", "intention_reconsider"];
    for (const name of desireNames) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing desire tool: ${name}`,
      );
    }
  });

  it("should register planning tools", () => {
    const planNames = [
      "plan_generate",
      "plan_execute_step",
      "htn_decompose",
      "plan_library_search",
      "plan_adapt",
    ];
    for (const name of planNames) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing planning tool: ${name}`,
      );
    }
  });
});

describe("Knowledge & Reasoning Tools", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should register fact store tools", () => {
    const names = ["fact_assert", "fact_query", "fact_retract", "fact_explain"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing fact store tool: ${name}`,
      );
    }
  });

  it("should register inference tools", () => {
    const names = ["infer_forward", "infer_backward", "infer_abductive"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing inference tool: ${name}`,
      );
    }
  });

  it("should register reasoning tools", () => {
    const names = ["reason", "reason_bayesian", "reason_causal", "reason_counterfactual"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing reasoning tool: ${name}`,
      );
    }
  });

  it("should register CBR tools", () => {
    const names = ["cbr_retrieve", "cbr_store"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing CBR tool: ${name}`,
      );
    }
  });
});

describe("Business & Operations Tools", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should register business tools", () => {
    const names = ["business_create", "business_list", "business_status"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing business tool: ${name}`,
      );
    }
  });

  it("should register onboarding tools", () => {
    const names = ["onboard_business", "togaf_generate", "bmc_generate", "tropos_generate"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing onboarding tool: ${name}`,
      );
    }
  });

  it("should register stakeholder tools", () => {
    const names = [
      "stakeholder_profile",
      "decision_review",
      "decision_resolve",
      "governance_check",
    ];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing stakeholder tool: ${name}`,
      );
    }
  });

  it("should register workforce tools", () => {
    const names = [
      "contractor_add",
      "contractor_list",
      "work_package_create",
      "work_package_assign",
    ];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing workforce tool: ${name}`,
      );
    }
  });

  it("should register marketing tools", () => {
    const names = ["marketing_connect", "content_publish", "ad_campaign_create"];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing marketing tool: ${name}`,
      );
    }
  });

  it("should register ontology management tools", () => {
    const names = [
      "ontology_propose_concept",
      "ontology_validate_proposal",
      "ontology_merge_approved",
      "ontology_list_proposals",
      "ontology_scaffold_domain",
    ];
    for (const name of names) {
      assert.ok(
        tools.find((t) => t.name === name),
        `Missing ontology management tool: ${name}`,
      );
    }
  });
});

describe("Tool Categories", () => {
  let tools: RegisteredTool[];

  beforeEach(() => {
    const mock = createMockApi();
    register(mock.api as any);
    tools = mock.tools;
  });

  it("should cover all 20 tool modules", () => {
    // Sample one tool from each module to verify loading
    const moduleProbes: Record<string, string> = {
      "bdi-tools": "bdi_cycle",
      "planning-tools": "plan_generate",
      "cbr-tools": "cbr_retrieve",
      "knowledge-tools": "ontology_query",
      "reasoning-tools": "reason",
      "communication-tools": "agent_message",
      "business-tools": "business_create",
      "metrics-tools": "metrics_record",
      "desire-tools": "desire_create",
      "fact-store": "fact_assert",
      "inference-tools": "infer_forward",
      "rule-engine": "rule_create",
      "memory-tools": "memory_store_item",
      "onboarding-tools": "onboard_business",
      "stakeholder-tools": "stakeholder_profile",
      "workforce-tools": "contractor_add",
      "integration-tools": "integration_setup",
      "reporting-tools": "report_generate",
      "marketing-tools": "marketing_connect",
      "ontology-management-tools": "ontology_propose_concept",
    };

    for (const [module, toolName] of Object.entries(moduleProbes)) {
      assert.ok(
        tools.find((t) => t.name === toolName),
        `Module ${module} not loaded — missing tool: ${toolName}`,
      );
    }
  });
});
