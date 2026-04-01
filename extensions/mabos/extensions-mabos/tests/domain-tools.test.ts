/**
 * Tests for domain-specific tools added for CFO, CMO, CTO, COO gaps.
 */

import { describe, it, assert, beforeEach } from "vitest";
import { createFinancialTools } from "../src/tools/financial-tools.js";
import { createOperationsTools } from "../src/tools/operations-tools.js";
import { createTechOpsTools } from "../src/tools/techops-tools.js";

// Minimal mock API
function mockApi(config: Record<string, unknown> = {}): any {
  return {
    config: {
      agents: { defaults: { workspace: "/tmp/mabos-test" } },
      ...config,
    },
    pluginConfig: config,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    getSkillSnapshot: () => ({ skills: [] }),
  };
}

describe("financial-tools (CFO domain)", () => {
  let tools: any[];

  beforeEach(() => {
    tools = createFinancialTools(mockApi());
  });

  it("registers financial_scenario tool", () => {
    const tool = tools.find((t) => t.name === "financial_scenario");
    assert.ok(tool, "financial_scenario should exist");
    assert.ok(tool.description.toLowerCase().includes("scenario"));
  });

  it("registers financial_reconcile tool", () => {
    const tool = tools.find((t) => t.name === "financial_reconcile");
    assert.ok(tool, "financial_reconcile should exist");
  });

  it("registers financial_variance tool", () => {
    const tool = tools.find((t) => t.name === "financial_variance");
    assert.ok(tool, "financial_variance should exist");
  });

  it("registers financial_forecast tool", () => {
    const tool = tools.find((t) => t.name === "financial_forecast");
    assert.ok(tool, "financial_forecast should exist");
  });

  it("registers financial_budget tool", () => {
    const tool = tools.find((t) => t.name === "financial_budget");
    assert.ok(tool, "financial_budget should exist");
  });
});

describe("operations-tools (COO domain)", () => {
  let tools: any[];

  beforeEach(() => {
    tools = createOperationsTools(mockApi());
  });

  it("registers supply_chain_status tool", () => {
    const tool = tools.find((t) => t.name === "supply_chain_status");
    assert.ok(tool, "supply_chain_status should exist");
  });

  it("registers vendor_score tool", () => {
    const tool = tools.find((t) => t.name === "vendor_score");
    assert.ok(tool, "vendor_score should exist");
  });

  it("registers sla_track tool", () => {
    const tool = tools.find((t) => t.name === "sla_track");
    assert.ok(tool, "sla_track should exist");
  });

  it("registers capacity_plan tool", () => {
    const tool = tools.find((t) => t.name === "capacity_plan");
    assert.ok(tool, "capacity_plan should exist");
  });

  it("registers inventory_status tool", () => {
    const tool = tools.find((t) => t.name === "inventory_status");
    assert.ok(tool, "inventory_status should exist");
  });
});

describe("techops-tools (CTO domain)", () => {
  let tools: any[];

  beforeEach(() => {
    tools = createTechOpsTools(mockApi());
  });

  it("registers cicd_pipeline tool", () => {
    const tool = tools.find((t) => t.name === "cicd_pipeline");
    assert.ok(tool, "cicd_pipeline should exist");
  });

  it("registers cicd_deploy tool", () => {
    const tool = tools.find((t) => t.name === "cicd_deploy");
    assert.ok(tool, "cicd_deploy should exist");
  });

  it("registers security_scan tool", () => {
    const tool = tools.find((t) => t.name === "security_scan");
    assert.ok(tool, "security_scan should exist");
  });

  it("registers apm_dashboard tool", () => {
    const tool = tools.find((t) => t.name === "apm_dashboard");
    assert.ok(tool, "apm_dashboard should exist");
  });
});
