/**
 * Capabilities Sync Tool Tests
 *
 * Validates that `capabilities_sync` regenerates Capabilities.md from
 * registered MABOS tools (categorized) and OpenClaw skills, while
 * preserving custom sections.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "vitest";
import {
  createCapabilitiesSyncTools,
  categorize,
  TOOL_CATEGORIES,
} from "../src/tools/capabilities-sync.js";

// ── Mock OpenClawPluginApi ──

function createMockApi(opts: {
  workspace: string;
  skills?: Array<{ name: string; primaryEnv?: string }>;
  hasGetSkillSnapshot?: boolean;
}) {
  const base: Record<string, any> = {
    id: "mabos-test",
    name: "MABOS Test",
    version: "0.1.0",
    description: "Test instance",
    source: "test",
    config: {
      agents: {
        defaults: {
          workspace: opts.workspace,
        },
      },
    },
    pluginConfig: {},
    runtime: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: () => {},
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

  if (opts.hasGetSkillSnapshot !== false) {
    base.getSkillSnapshot = () => ({
      prompt: "",
      skills: opts.skills ?? [],
    });
  }

  return base;
}

// ── Tests ──

describe("capabilities_sync tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mabos-capsync-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates Capabilities.md with MABOS tools and OpenClaw skills", async () => {
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });

    const api = createMockApi({
      workspace: tmpDir,
      skills: [{ name: "web-search", primaryEnv: "browser" }, { name: "code-execution" }],
    });

    const registeredToolNames = [
      "belief_get",
      "belief_update",
      "goal_create",
      "shopify_catalog",
      "reason",
      "memory_store_item",
      "agent_message",
      "business_create",
      "content_publish",
      "cloudflare_deploy",
    ];

    const tools = createCapabilitiesSyncTools(api as any, { registeredToolNames });
    const capSync = tools.find((t) => t.name === "capabilities_sync");
    assert.ok(capSync, "capabilities_sync tool should exist");

    const result = await capSync.execute("test-call", { agent_id: "test-agent" });

    // Verify return message includes counts
    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("10 MABOS tools"),
      `Result should mention 10 MABOS tools, got: ${resultText}`,
    );
    assert.ok(
      resultText.includes("2 OpenClaw skills"),
      `Result should mention 2 OpenClaw skills, got: ${resultText}`,
    );

    // Read and verify generated file
    const capMd = await readFile(join(agentDir, "Capabilities.md"), "utf-8");

    // Should have the main header
    assert.ok(capMd.includes("# Capabilities — test-agent"), "Should have agent-specific header");

    // Should have MABOS BDI Tools section
    assert.ok(capMd.includes("## MABOS BDI Tools"), "Should have MABOS BDI Tools section");

    // Should have OpenClaw Skills section
    assert.ok(capMd.includes("## OpenClaw Skills"), "Should have OpenClaw Skills section");
    assert.ok(capMd.includes("`web-search`"), "Should include web-search skill");
    assert.ok(capMd.includes("_(browser)_"), "Should include primaryEnv note");
    assert.ok(capMd.includes("`code-execution`"), "Should include code-execution skill");

    // Verify categorization
    assert.ok(capMd.includes("### BDI Cognitive"), "Should have BDI Cognitive subsection");
    assert.ok(capMd.includes("`belief_get`"), "belief_get should be under BDI Cognitive");
    assert.ok(capMd.includes("`belief_update`"), "belief_update should be under BDI Cognitive");
    assert.ok(capMd.includes("`goal_create`"), "goal_create should be under BDI Cognitive");

    assert.ok(capMd.includes("### E-commerce"), "Should have E-commerce subsection");
    assert.ok(capMd.includes("`shopify_catalog`"), "shopify_catalog should be under E-commerce");

    assert.ok(
      capMd.includes("### Reasoning & Knowledge"),
      "Should have Reasoning & Knowledge subsection",
    );
    assert.ok(capMd.includes("`reason`"), "reason should be under Reasoning & Knowledge");

    assert.ok(capMd.includes("### Memory"), "Should have Memory subsection");
    assert.ok(capMd.includes("`memory_store_item`"), "memory_store_item should be under Memory");

    assert.ok(capMd.includes("### Communication"), "Should have Communication subsection");
    assert.ok(capMd.includes("`agent_message`"), "agent_message should be under Communication");

    assert.ok(
      capMd.includes("### Business Operations"),
      "Should have Business Operations subsection",
    );
    assert.ok(
      capMd.includes("`business_create`"),
      "business_create should be under Business Operations",
    );

    assert.ok(
      capMd.includes("### Marketing & Content"),
      "Should have Marketing & Content subsection",
    );
    assert.ok(
      capMd.includes("`content_publish`"),
      "content_publish should be under Marketing & Content",
    );

    assert.ok(capMd.includes("### Infrastructure"), "Should have Infrastructure subsection");
    assert.ok(
      capMd.includes("`cloudflare_deploy`"),
      "cloudflare_deploy should be under Infrastructure",
    );
  });

  it("preserves custom sections from existing Capabilities.md", async () => {
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });

    // Pre-create Capabilities.md with custom sections
    await writeFile(
      join(agentDir, "Capabilities.md"),
      `# Capabilities — test-agent

## MABOS BDI Tools

### BDI Cognitive

- \`belief_get\`

## Constraints

- Must not exceed $500 spend without approval
- All API calls must use HTTPS

## Notes

- Agent was onboarded on 2026-01-15
- Primary focus: financial operations
`,
      "utf-8",
    );

    const api = createMockApi({
      workspace: tmpDir,
      skills: [],
    });

    const registeredToolNames = ["belief_get", "belief_update", "goal_create"];

    const tools = createCapabilitiesSyncTools(api as any, { registeredToolNames });
    const capSync = tools.find((t) => t.name === "capabilities_sync");
    assert.ok(capSync, "capabilities_sync tool should exist");

    const result = await capSync.execute("test-call", { agent_id: "test-agent" });

    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("2 custom sections preserved"),
      `Should preserve 2 custom sections, got: ${resultText}`,
    );

    // Read and verify
    const capMd = await readFile(join(agentDir, "Capabilities.md"), "utf-8");

    // Auto-generated sections should be present
    assert.ok(capMd.includes("## MABOS BDI Tools"), "Should have MABOS BDI Tools section");
    assert.ok(capMd.includes("`belief_get`"), "Should include belief_get");
    assert.ok(capMd.includes("`belief_update`"), "Should include belief_update");
    assert.ok(capMd.includes("`goal_create`"), "Should include goal_create");

    // Custom sections should be preserved
    assert.ok(capMd.includes("## Constraints"), "Should preserve Constraints section");
    assert.ok(
      capMd.includes("Must not exceed $500 spend without approval"),
      "Should preserve Constraints content",
    );
    assert.ok(capMd.includes("## Notes"), "Should preserve Notes section");
    assert.ok(capMd.includes("Agent was onboarded on 2026-01-15"), "Should preserve Notes content");
  });

  it("handles missing getSkillSnapshot gracefully", async () => {
    const agentDir = join(tmpDir, "agents", "test-agent");
    await mkdir(agentDir, { recursive: true });

    // API without getSkillSnapshot
    const api = createMockApi({
      workspace: tmpDir,
      hasGetSkillSnapshot: false,
    });

    const registeredToolNames = ["belief_get", "goal_create"];

    const tools = createCapabilitiesSyncTools(api as any, { registeredToolNames });
    const capSync = tools.find((t) => t.name === "capabilities_sync");
    assert.ok(capSync, "capabilities_sync tool should exist");

    // Should not throw
    const result = await capSync.execute("test-call", { agent_id: "test-agent" });

    const resultText = result.content[0].text;
    assert.ok(
      resultText.includes("0 OpenClaw skills"),
      `Should mention 0 OpenClaw skills, got: ${resultText}`,
    );

    // Read and verify
    const capMd = await readFile(join(agentDir, "Capabilities.md"), "utf-8");

    // Should have MABOS tools
    assert.ok(capMd.includes("## MABOS BDI Tools"), "Should have MABOS BDI Tools section");
    assert.ok(capMd.includes("`belief_get`"), "Should include belief_get");

    // Should NOT have OpenClaw Skills section
    assert.ok(
      !capMd.includes("## OpenClaw Skills"),
      "Should NOT have OpenClaw Skills section when no snapshot",
    );
  });
});

describe("categorize function", () => {
  it("categorizes BDI Cognitive tools correctly", () => {
    assert.equal(categorize("belief_get"), "BDI Cognitive");
    assert.equal(categorize("belief_update"), "BDI Cognitive");
    assert.equal(categorize("goal_create"), "BDI Cognitive");
    assert.equal(categorize("desire_create"), "BDI Cognitive");
    assert.equal(categorize("intention_commit"), "BDI Cognitive");
    assert.equal(categorize("bdi_cycle"), "BDI Cognitive");
    assert.equal(categorize("plan_generate"), "BDI Cognitive");
    assert.equal(categorize("skill_inventory"), "BDI Cognitive");
    assert.equal(categorize("action_log"), "BDI Cognitive");
  });

  it("categorizes Reasoning & Knowledge tools correctly", () => {
    assert.equal(categorize("reason"), "Reasoning & Knowledge");
    assert.equal(categorize("reason_bayesian"), "Reasoning & Knowledge");
    assert.equal(categorize("knowledge_query"), "Reasoning & Knowledge");
    assert.equal(categorize("ontology_query"), "Reasoning & Knowledge");
    assert.equal(categorize("fact_assert"), "Reasoning & Knowledge");
    assert.equal(categorize("infer_forward"), "Reasoning & Knowledge");
    assert.equal(categorize("htn_decompose"), "Reasoning & Knowledge");
    assert.equal(categorize("rule_create"), "Reasoning & Knowledge");
    assert.equal(categorize("cbr_retrieve"), "Reasoning & Knowledge");
  });

  it("categorizes E-commerce tools correctly", () => {
    assert.equal(categorize("shopify_catalog"), "E-commerce");
    assert.equal(categorize("stripe_charge"), "E-commerce");
    assert.equal(categorize("order_create"), "E-commerce");
    assert.equal(categorize("pictorem_upload"), "E-commerce");
  });

  it("returns Other for unrecognized tools", () => {
    assert.equal(categorize("custom_tool"), "Other");
    assert.equal(categorize("unknown_prefix"), "Other");
    assert.equal(categorize("capabilities_sync"), "Other");
  });
});

describe("TOOL_CATEGORIES export", () => {
  it("is a non-empty record of category names to regex arrays", () => {
    assert.ok(Object.keys(TOOL_CATEGORIES).length > 0, "Should have categories");
    for (const [cat, patterns] of Object.entries(TOOL_CATEGORIES)) {
      assert.ok(cat.length > 0, "Category name should be non-empty");
      assert.ok(Array.isArray(patterns), `${cat} should have array of patterns`);
      assert.ok(patterns.length > 0, `${cat} should have at least one pattern`);
      for (const p of patterns) {
        assert.ok(p instanceof RegExp, `${cat} patterns should be RegExp instances`);
      }
    }
  });
});
