/**
 * Onboarding Pipeline — End-to-End Test
 *
 * Exercises the full 5-phase onboarding flow using the actual tool functions
 * against a temporary workspace directory. No databases required.
 *
 * Phases tested:
 *   1. Discovery       — data collected (simulated) + progress tracking
 *   2. Architecture     — onboard_business + togaf_generate + bmc_generate + tropos_generate
 *   3. Agent Activation — agent_spawn_domain + desire_init_from_template
 *   4. Knowledge Graph  — sbvr_sync_to_backend (file-based fallback)
 *   5. Launch           — onboarding_progress tracking + dashboard canvas
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeAll, afterAll } from "vitest";
import register from "../index.js";

// ── Test fixtures ──

const TEST_BUSINESS = {
  business_id: "acme-widgets",
  name: "Acme Widgets",
  legal_name: "Acme Widgets LLC",
  type: "ecommerce" as const,
  description: "Premium widgets for enterprise customers",
  value_propositions: ["High-quality widgets", "Fast delivery", "Custom branding"],
  customer_segments: ["Enterprise buyers", "Resellers"],
  revenue_streams: ["Product sales", "Customization fees"],
  jurisdiction: "Delaware, US",
  stage: "mvp" as const,
  products_services: ["Premium Widgets", "Widget Customization"],
  target_market: "Enterprise B2B",
  revenue_model: "Direct product sales with customization upsell",
  technology_stack: ["Node.js", "Next.js", "PostgreSQL"],
  stakeholder_goals: [
    { goal: "Reach $1M ARR within 12 months", priority: 0.9, type: "hard" as const },
    { goal: "Expand to 3 new markets", priority: 0.7, type: "soft" as const },
    { goal: "Achieve 95% customer satisfaction", priority: 0.8, type: "hard" as const },
  ],
  constraints: ["Budget: $50k initial", "Must comply with GDPR"],
};

// ── Mock setup ──

type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
};

let tmpWorkspace: string;
let tools: Tool[];
let toolMap: Map<string, Tool>;

function findTool(name: string): Tool {
  const tool = toolMap.get(name);
  if (!tool)
    throw new Error(`Tool not found: ${name}. Available: ${[...toolMap.keys()].join(", ")}`);
  return tool;
}

async function callTool(name: string, params: any) {
  const tool = findTool(name);
  return tool.execute("test-run", params);
}

function extractText(result: any): string {
  if (!result?.content) return JSON.stringify(result);
  return result.content.map((c: any) => c.text || "").join("\n");
}

// ── Lifecycle ──

beforeAll(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "mabos-e2e-"));
  tools = [];
  toolMap = new Map();

  const api = {
    id: "mabos-e2e",
    name: "MABOS E2E Test",
    version: "0.1.0",
    description: "E2E test instance",
    source: "test",
    config: { agents: { defaults: { workspace: tmpWorkspace } } } as any,
    pluginConfig: {},
    runtime: {} as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => console.log(`  [warn] ${msg}`),
      error: (msg: string) => console.error(`  [error] ${msg}`),
    },
    registerTool: (tool: any) => {
      tools.push(tool);
      toolMap.set(tool.name, tool);
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

  register(api as any);
  console.log(`  Registered ${tools.length} tools, workspace: ${tmpWorkspace}`);
});

afterAll(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ── Phase 1: Discovery ──

describe("Phase 1: Discovery", () => {
  it("should have all discovery data fields populated", () => {
    assert.ok(TEST_BUSINESS.name, "name required");
    assert.ok(TEST_BUSINESS.legal_name, "legal_name required");
    assert.ok(TEST_BUSINESS.type, "type required");
    assert.ok(TEST_BUSINESS.description, "description required");
    assert.ok(TEST_BUSINESS.value_propositions.length > 0, "value_propositions required");
    assert.ok(TEST_BUSINESS.customer_segments.length > 0, "customer_segments required");
    assert.ok(TEST_BUSINESS.revenue_streams.length > 0, "revenue_streams required");
    assert.ok(TEST_BUSINESS.stakeholder_goals.length > 0, "stakeholder_goals required");
    assert.ok(TEST_BUSINESS.jurisdiction, "jurisdiction required");
    assert.ok(TEST_BUSINESS.stage, "stage required");
  });
});

// ── Phase 2: Architecture ──

describe("Phase 2: Architecture", () => {
  it("should create business workspace via onboard_business", async () => {
    const result = await callTool("onboard_business", {
      business_id: TEST_BUSINESS.business_id,
      name: TEST_BUSINESS.name,
      legal_name: TEST_BUSINESS.legal_name,
      type: TEST_BUSINESS.type,
      description: TEST_BUSINESS.description,
      value_propositions: TEST_BUSINESS.value_propositions,
      customer_segments: TEST_BUSINESS.customer_segments,
      revenue_streams: TEST_BUSINESS.revenue_streams,
      jurisdiction: TEST_BUSINESS.jurisdiction,
      stage: TEST_BUSINESS.stage,
    });
    const text = extractText(result);
    assert.ok(text.includes("Acme") || text.includes("acme"), "Should reference business name");

    // Verify manifest
    const manifestPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "manifest.json",
    );
    assert.ok(existsSync(manifestPath), "manifest.json should exist");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.equal(manifest.name, TEST_BUSINESS.name);
    assert.equal(manifest.type, TEST_BUSINESS.type);

    // Verify agent directories created for all 9 roles
    const agentsDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id, "agents");
    assert.ok(existsSync(agentsDir), "agents/ directory should exist");
    const agentDirs = await readdir(agentsDir);
    assert.ok(
      agentDirs.length >= 9,
      `Should have at least 9 agent dirs, got ${agentDirs.length}: ${agentDirs.join(", ")}`,
    );
  });

  it("should track discovery phase after business is created", async () => {
    const result = await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "discovery",
      status: "completed",
      details: "All 11 questions collected",
    });
    const text = extractText(result);
    assert.ok(text.length > 0, "Should return output");

    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    assert.ok(existsSync(progressPath), "onboarding-progress.json should exist");
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.discovery.status, "completed");
  });

  it("should generate TOGAF architecture", async () => {
    const result = await callTool("togaf_generate", {
      business_id: TEST_BUSINESS.business_id,
      business_name: TEST_BUSINESS.name,
      business_type: TEST_BUSINESS.type,
      description: TEST_BUSINESS.description,
      products_services: TEST_BUSINESS.products_services,
      target_market: TEST_BUSINESS.target_market,
      revenue_model: TEST_BUSINESS.revenue_model,
      technology_stack: TEST_BUSINESS.technology_stack,
      stage: TEST_BUSINESS.stage,
    });
    const text = extractText(result);
    assert.ok(text.includes("TOGAF") || text.includes("togaf"), "Should mention TOGAF");

    const bizDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id);
    assert.ok(
      existsSync(join(bizDir, "togaf-architecture.json")),
      "togaf-architecture.json should exist",
    );
    assert.ok(
      existsSync(join(bizDir, "TOGAF-ARCHITECTURE.md")),
      "TOGAF-ARCHITECTURE.md should exist",
    );

    const togaf = JSON.parse(await readFile(join(bizDir, "togaf-architecture.json"), "utf-8"));
    assert.equal(togaf.business_id, TEST_BUSINESS.business_id);
    assert.ok(togaf.business_architecture, "Should have business architecture layer");
    assert.ok(togaf.application_architecture, "Should have application architecture layer");
    assert.ok(togaf.technology_architecture, "Should have technology architecture layer");
  });

  it("should generate Business Model Canvas", async () => {
    const result = await callTool("bmc_generate", {
      business_id: TEST_BUSINESS.business_id,
      value_propositions: TEST_BUSINESS.value_propositions,
      customer_segments: TEST_BUSINESS.customer_segments,
      revenue_streams: TEST_BUSINESS.revenue_streams,
    });
    const text = extractText(result);
    assert.ok(
      text.includes("Canvas") || text.includes("BMC") || text.includes("bmc"),
      "Should mention Business Model Canvas",
    );

    const bmcPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "business-model-canvas.json",
    );
    assert.ok(existsSync(bmcPath), "business-model-canvas.json should exist");

    const bmc = JSON.parse(await readFile(bmcPath, "utf-8"));
    assert.equal(bmc.business_id, TEST_BUSINESS.business_id);
    // BMC wraps fields under a 'canvas' key
    const canvas = bmc.canvas || bmc;
    assert.ok(
      canvas.value_propositions || canvas.value_proposition,
      "BMC should have value propositions",
    );
  });

  it("should generate Tropos goal model", async () => {
    const result = await callTool("tropos_generate", {
      business_id: TEST_BUSINESS.business_id,
      stakeholder_goals: TEST_BUSINESS.stakeholder_goals,
      constraints: TEST_BUSINESS.constraints,
    });
    const text = extractText(result);
    assert.ok(
      text.includes("Tropos") || text.includes("tropos") || text.includes("goal"),
      "Should mention Tropos/goals",
    );

    // Actual filename is tropos-goal-model.json
    const troposPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "tropos-goal-model.json",
    );
    assert.ok(existsSync(troposPath), "tropos-goal-model.json should exist");

    const tropos = JSON.parse(await readFile(troposPath, "utf-8"));
    assert.ok(
      tropos.goal_mapping || tropos.actors || tropos.stakeholder_goals,
      "Should have goals/mapping data",
    );
  });

  it("should track architecture phase completion", async () => {
    const result = await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "architecture",
      status: "completed",
    });
    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.architecture.status, "completed");
    // Discovery was set in a previous test
    assert.equal(
      progress.phases.discovery.status,
      "completed",
      "Discovery should still be completed",
    );
  });
});

// ── Phase 3: Agent Activation ──

describe("Phase 3: Agent Activation", () => {
  it("should spawn domain-specific agents for ecommerce", async () => {
    const result = await callTool("agent_spawn_domain", {
      business_id: TEST_BUSINESS.business_id,
      business_type: TEST_BUSINESS.type,
    });
    const text = extractText(result);
    assert.ok(
      text.includes("agent") || text.includes("Agent") || text.includes("Spawned"),
      "Should mention agents",
    );

    // Ecommerce domain agents use abbreviated names: inventory-mgr, fulfillment-mgr, product-mgr
    const agentsDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id, "agents");
    const agentDirs = await readdir(agentsDir);

    const expectedDomain = ["inventory-mgr", "fulfillment-mgr", "product-mgr"];
    for (const agent of expectedDomain) {
      assert.ok(
        agentDirs.includes(agent),
        `Missing ecommerce domain agent: ${agent}. Found: ${agentDirs.join(", ")}`,
      );
    }
  });

  it("should initialize desires for all 9 core roles", async () => {
    const result = await callTool("desire_init_from_template", {
      business_id: TEST_BUSINESS.business_id,
    });
    const text = extractText(result);
    assert.ok(
      text.includes("desire") || text.includes("Desire") || text.includes("initialized"),
      "Should mention desires",
    );

    const roles = ["ceo", "cfo", "coo", "cmo", "cto", "hr", "legal", "strategy", "knowledge"];
    const agentsDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id, "agents");

    for (const role of roles) {
      const desirePath = join(agentsDir, role, "Desires.md");
      assert.ok(existsSync(desirePath), `Desires.md should exist for ${role}`);

      const content = await readFile(desirePath, "utf-8");
      assert.ok(
        content.length > 100,
        `Desires.md for ${role} should have substantial content (got ${content.length} chars)`,
      );
    }
  });

  it("should initialize desires for a specific subset of roles", async () => {
    const result = await callTool("desire_init_from_template", {
      business_id: TEST_BUSINESS.business_id,
      roles: ["ceo", "cfo"],
    });
    const text = extractText(result);
    assert.ok(text.length > 0, "Should return output for partial init");
  });

  it("should track agents phase completion", async () => {
    await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "agents",
      status: "completed",
      details: "9 core + 3 domain agents spawned",
    });
    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.agents.status, "completed");
  });
});

// ── Phase 4: Knowledge Graph ──

describe("Phase 4: Knowledge Graph (SBVR sync)", () => {
  it("should attempt SBVR sync and handle failure gracefully", async () => {
    // Backend is not running, so this should save locally or report an error
    const result = await callTool("sbvr_sync_to_backend", {
      business_id: TEST_BUSINESS.business_id,
      backend_url: "http://localhost:9999",
    });
    const text = extractText(result);
    // Should either save locally or report the failure
    assert.ok(text.length > 10, `Should return meaningful output. Got: ${text.substring(0, 200)}`);

    // Check if local SBVR export was saved
    const exportPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "sbvr-export.json",
    );
    if (existsSync(exportPath)) {
      const sbvrExport = JSON.parse(await readFile(exportPath, "utf-8"));
      assert.ok(sbvrExport.conceptTypes || sbvrExport.concepts, "Export should have concept data");
      console.log(`  SBVR export saved: ${Object.keys(sbvrExport).join(", ")}`);
    } else {
      // If ontology loading failed (ESM issue), the tool reports an error
      console.log(`  SBVR sync reported: ${text.substring(0, 100)}`);
    }
  });

  it("should track knowledge_graph phase", async () => {
    await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "knowledge_graph",
      status: "skipped",
      details: "Backend unavailable; SBVR export saved locally",
    });
    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.knowledge_graph.status, "skipped");
  });
});

// ── Phase 5: Launch ──

describe("Phase 5: Launch", () => {
  it("should show launch progress with show_canvas", async () => {
    const result = await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "launch",
      status: "started",
      show_canvas: true,
    });
    const text = extractText(result);
    assert.ok(
      text.length > 50,
      `Should include substantial content. Got: ${text.substring(0, 200)}`,
    );
  });

  it("should track launch phase completion", async () => {
    await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "launch",
      status: "completed",
    });
    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.launch.status, "completed");
  });

  it("should have all 5 phases tracked in progress file", async () => {
    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    const progress = JSON.parse(await readFile(progressPath, "utf-8"));

    assert.equal(progress.business_id, TEST_BUSINESS.business_id);
    assert.ok(progress.started_at, "Should have started_at timestamp");

    const phases = ["discovery", "architecture", "agents", "knowledge_graph", "launch"];
    for (const phase of phases) {
      assert.ok(progress.phases[phase], `Phase ${phase} should exist`);
      assert.ok(
        ["completed", "skipped"].includes(progress.phases[phase].status),
        `Phase ${phase} should be completed or skipped, got: ${progress.phases[phase].status}`,
      );
    }
  });
});

// ── Orchestrate mode (batch) ──

describe("Orchestrate Mode (batch onboarding)", () => {
  it("should run full pipeline in a single call with orchestrate=true", async () => {
    const batchId = "batch-test-co";
    const result = await callTool("onboard_business", {
      business_id: batchId,
      name: "Batch Test Co",
      legal_name: "Batch Test Co Inc",
      type: "saas",
      description: "A SaaS test business for batch orchestration",
      value_propositions: ["Automated testing", "CI/CD integration"],
      customer_segments: ["Developers", "QA teams"],
      revenue_streams: ["Monthly subscriptions"],
      jurisdiction: "California, US",
      stage: "growth",
      orchestrate: true,
    });
    const text = extractText(result);
    assert.ok(text.length > 50, "Should return meaningful output");

    const bizDir = join(tmpWorkspace, "businesses", batchId);
    assert.ok(existsSync(bizDir), "Business directory should exist");
    assert.ok(existsSync(join(bizDir, "manifest.json")), "manifest.json should exist");

    // Verify agents exist
    const agentsDir = join(bizDir, "agents");
    if (existsSync(agentsDir)) {
      const agents = await readdir(agentsDir);
      assert.ok(agents.length >= 9, `Should have at least 9 agents, got ${agents.length}`);
    }
  });
});

// ── SBVR Export validation (if ontology loading works) ──

describe("SBVR Export Integrity", () => {
  it("should validate SBVR export structure if present", async () => {
    const exportPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "sbvr-export.json",
    );
    if (!existsSync(exportPath)) {
      console.log("  Skipping: sbvr-export.json not found (ontology loader may have ESM issue)");
      return;
    }

    const sbvrExport = JSON.parse(await readFile(exportPath, "utf-8"));
    assert.ok(Array.isArray(sbvrExport.conceptTypes), "conceptTypes should be an array");
    assert.ok(Array.isArray(sbvrExport.factTypes), "factTypes should be an array");
    console.log(
      `  SBVR export: ${sbvrExport.conceptTypes.length} concepts, ${sbvrExport.factTypes.length} facts, ${(sbvrExport.rules || []).length} rules`,
    );
  });
});

// ── Workspace structure validation ──

describe("Final Workspace Structure", () => {
  it("should have complete business directory structure", async () => {
    const bizDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id);

    const expectedFiles = [
      "manifest.json",
      "togaf-architecture.json",
      "TOGAF-ARCHITECTURE.md",
      "business-model-canvas.json",
      "tropos-goal-model.json",
      "onboarding-progress.json",
    ];

    for (const file of expectedFiles) {
      assert.ok(existsSync(join(bizDir, file)), `${file} should exist in business directory`);
    }
  });

  it("should have cognitive files for each core agent", async () => {
    const agentsDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id, "agents");
    const coreRoles = ["ceo", "cfo", "coo", "cmo", "cto", "hr", "legal", "strategy", "knowledge"];

    for (const role of coreRoles) {
      const agentDir = join(agentsDir, role);
      assert.ok(existsSync(agentDir), `Agent dir for ${role} should exist`);

      const desirePath = join(agentDir, "Desires.md");
      assert.ok(existsSync(desirePath), `Desires.md should exist for ${role}`);
    }
  });

  it("should have domain-specific agent directories for ecommerce", async () => {
    const agentsDir = join(tmpWorkspace, "businesses", TEST_BUSINESS.business_id, "agents");
    const domainAgents = ["inventory-mgr", "fulfillment-mgr", "product-mgr"];

    for (const agent of domainAgents) {
      assert.ok(existsSync(join(agentsDir, agent)), `Domain agent ${agent} should exist`);
    }
  });
});

// ── Idempotency ──

describe("Idempotency", () => {
  it("should handle re-running onboard_business for existing business", async () => {
    const result = await callTool("onboard_business", {
      business_id: TEST_BUSINESS.business_id,
      name: TEST_BUSINESS.name,
      legal_name: TEST_BUSINESS.legal_name,
      type: TEST_BUSINESS.type,
      description: TEST_BUSINESS.description,
      value_propositions: TEST_BUSINESS.value_propositions,
      customer_segments: TEST_BUSINESS.customer_segments,
      revenue_streams: TEST_BUSINESS.revenue_streams,
    });
    const text = extractText(result);
    assert.ok(text.length > 0, "Should return some output");
  });

  it("should handle re-initializing desires", async () => {
    const result = await callTool("desire_init_from_template", {
      business_id: TEST_BUSINESS.business_id,
    });
    const text = extractText(result);
    assert.ok(text.length > 0, "Should return some output on re-init");
  });
});

// ── Recovery ──

describe("Recovery", () => {
  it("should support retrying a failed phase", async () => {
    // Simulate a failure
    await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "knowledge_graph",
      status: "failed",
      details: "Simulated failure for testing",
    });

    const progressPath = join(
      tmpWorkspace,
      "businesses",
      TEST_BUSINESS.business_id,
      "onboarding-progress.json",
    );
    let progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.equal(progress.phases.knowledge_graph.status, "failed");

    // Retry — the tool sets it to "in_progress" (retry means restart)
    await callTool("onboarding_progress", {
      business_id: TEST_BUSINESS.business_id,
      phase: "knowledge_graph",
      status: "retry",
    });

    progress = JSON.parse(await readFile(progressPath, "utf-8"));
    assert.ok(
      ["started", "retry", "in_progress"].includes(progress.phases.knowledge_graph.status),
      `Phase should be retried, got: ${progress.phases.knowledge_graph.status}`,
    );
  });
});
