/**
 * Memory Bridge Tests — verify MABOS memories are written in
 * OpenClaw's native Markdown format for automatic indexing.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeAll, afterAll } from "vitest";
import register from "../index.js";

// ── Mock setup (matches onboarding-e2e pattern) ──

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
  return findTool(name).execute("test-run", params);
}

beforeAll(async () => {
  tmpWorkspace = await mkdtemp(join(tmpdir(), "mabos-bridge-"));
  tools = [];
  toolMap = new Map();

  const api = {
    id: "mabos-bridge-test",
    name: "MABOS Bridge Test",
    version: "0.1.0",
    description: "Bridge test instance",
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
});

afterAll(async () => {
  await rm(tmpWorkspace, { recursive: true, force: true });
});

// ── Tests ──

describe("Memory Bridge: Native Format", () => {
  const AGENT_ID = "test-agent";
  const today = new Date().toISOString().split("T")[0];

  it("memory_store_item writes native daily log", async () => {
    await callTool("memory_store_item", {
      agent_id: AGENT_ID,
      content: "Discovered key market opportunity in Q2",
      type: "observation",
      importance: 0.7,
      source: "bdi-cycle",
      tags: ["market", "q2"],
    });

    const dailyPath = join(tmpWorkspace, "agents", AGENT_ID, "memory", `${today}.md`);
    assert.ok(existsSync(dailyPath), `Native daily log should exist at ${dailyPath}`);

    const content = await readFile(dailyPath, "utf-8");
    assert.ok(content.startsWith(`# ${today} — Agent Log`), "Should have date header");
    assert.ok(content.includes("## observation"), "Should have type as section heading");
    assert.ok(
      content.includes("Discovered key market opportunity in Q2"),
      "Should contain the memory content",
    );
    assert.ok(content.includes("[market, q2]"), "Should include tags");
    assert.ok(content.includes("(bdi-cycle)"), "Should include source");
  });

  it("memory_store_item preserves backward compat (Memory.md + memory-store.json)", async () => {
    // The store call above should have written both legacy files too
    const memoryMdPath = join(tmpWorkspace, "agents", AGENT_ID, "memory-journal.md");
    assert.ok(existsSync(memoryMdPath), "memory-journal.md should still exist");

    const memoryMd = await readFile(memoryMdPath, "utf-8");
    assert.ok(memoryMd.includes("observation"), "Memory.md should contain the memory type");

    const storePath = join(tmpWorkspace, "agents", AGENT_ID, "memory-store.json");
    assert.ok(existsSync(storePath), "memory-store.json should still exist");

    const store = JSON.parse(await readFile(storePath, "utf-8"));
    const allItems = [...store.working, ...store.short_term, ...store.long_term];
    assert.ok(
      allItems.some((i: any) => i.content.includes("market opportunity")),
      "JSON store should contain the item",
    );
  });

  it("memory_consolidate writes native MEMORY.md", async () => {
    // Store a high-importance item and access it to meet consolidation criteria
    await callTool("memory_store_item", {
      agent_id: AGENT_ID,
      content: "Revenue model validated by customer interviews",
      type: "lesson",
      importance: 0.9,
      source: "inference",
      tags: ["revenue", "validation"],
    });

    // Access it twice to meet min_access_count=2
    await callTool("memory_recall", { agent_id: AGENT_ID, query: "revenue" });
    await callTool("memory_recall", { agent_id: AGENT_ID, query: "revenue" });

    // Now consolidate
    await callTool("memory_consolidate", {
      agent_id: AGENT_ID,
      min_importance: 0.6,
      min_access_count: 2,
    });

    const nativeMemPath = join(tmpWorkspace, "agents", AGENT_ID, "MEMORY.md");
    assert.ok(existsSync(nativeMemPath), "Native MEMORY.md (all caps) should exist");

    const content = await readFile(nativeMemPath, "utf-8");
    assert.ok(
      content.startsWith("# MEMORY.md - Long-Term Memory"),
      "Should have long-term memory header",
    );
    assert.ok(
      content.includes(`## Consolidated (${today})`),
      "Should have dated consolidation section",
    );
    assert.ok(
      content.includes("Revenue model validated"),
      "Should contain consolidated item content",
    );
  });

  it("memory_consolidate dry_run skips native write", async () => {
    const freshAgent = "dry-run-agent";

    // Store a high-importance item
    await callTool("memory_store_item", {
      agent_id: freshAgent,
      content: "This should not appear in MEMORY.md",
      type: "fact",
      importance: 0.95,
      source: "test",
    });

    // Dry run consolidate
    await callTool("memory_consolidate", {
      agent_id: freshAgent,
      min_importance: 0.5,
      dry_run: true,
    });

    const nativeMemPath = join(tmpWorkspace, "agents", freshAgent, "MEMORY.md");
    assert.ok(!existsSync(nativeMemPath), "Native MEMORY.md should NOT exist after dry_run");
  });

  it("plan_execute_step writes native daily log", async () => {
    const planAgent = "plan-agent";

    // First create a plan so plan_execute_step has context
    await callTool("plan_generate", {
      agent_id: planAgent,
      plan_id: "P-001",
      name: "Market Research",
      goal_id: "G-001",
      source: "llm-generated",
      confidence: 0.8,
      strategy: "Systematic market analysis",
      steps: [{ id: "S-1", description: "Analyze competitors", type: "primitive" }],
    });

    // Execute the step
    await callTool("plan_execute_step", {
      agent_id: planAgent,
      plan_id: "P-001",
      step_id: "S-1",
      outcome: "success",
      result: "Identified 5 key competitors",
    });

    const dailyPath = join(tmpWorkspace, "agents", planAgent, "memory", `${today}.md`);
    assert.ok(existsSync(dailyPath), "Native daily log should exist for plan agent");

    const content = await readFile(dailyPath, "utf-8");
    assert.ok(
      content.includes("Plan P-001 / Step S-1: success"),
      "Should contain plan step reference",
    );
    assert.ok(content.includes("Identified 5 key competitors"), "Should contain step result");
    assert.ok(content.includes("(plan-execution)"), "Should have plan-execution source");
  });
});

describe("R1: Recursive Memory Consolidation", () => {
  const AGENT_ID = "r1-test-agent";

  it("memory_consolidate with summarize=true groups related items", async () => {
    // Store 5 related memories with overlapping tags
    for (let i = 0; i < 5; i++) {
      await callTool("memory_store_item", {
        agent_id: AGENT_ID,
        content: `Market analysis finding ${i + 1}: competitor ${i + 1} strategy`,
        type: "observation",
        importance: 0.8,
        source: "inference",
        tags: ["market", "competitor", `finding-${i + 1}`],
      });
    }

    // Access them to meet consolidation criteria
    await callTool("memory_recall", { agent_id: AGENT_ID, query: "market" });
    await callTool("memory_recall", { agent_id: AGENT_ID, query: "market" });

    // Consolidate with summarize=true
    await callTool("memory_consolidate", {
      agent_id: AGENT_ID,
      min_importance: 0.6,
      min_access_count: 2,
      summarize: true,
    });

    // Verify long-term has consolidated summary
    const storePath = join(tmpWorkspace, "agents", AGENT_ID, "memory-store.json");
    const store = JSON.parse(await readFile(storePath, "utf-8"));

    // Should have fewer items than 5 in long-term (grouped)
    const ltItems = store.long_term;
    assert.ok(ltItems.length > 0, "Should have long-term items");

    // At least one item should have derived_from
    const consolidated = ltItems.find((i: any) => i.derived_from && i.derived_from.length > 0);
    assert.ok(consolidated, "Should have at least one consolidated item with derived_from");
    assert.ok(
      consolidated.derived_from.length >= 2,
      "Consolidated item should reference multiple source memories",
    );
    assert.ok(
      consolidated.content.includes("[Consolidated from"),
      "Consolidated content should include merge marker",
    );
    assert.ok(consolidated.tags.includes("market"), "Consolidated item should have union of tags");
  });

  it("memory_consolidate with summarize=false preserves individual items", async () => {
    const agent = "r1-no-summarize";

    await callTool("memory_store_item", {
      agent_id: agent,
      content: "Individual item A",
      type: "fact",
      importance: 0.9,
      source: "test",
      tags: ["alpha"],
    });
    await callTool("memory_store_item", {
      agent_id: agent,
      content: "Individual item B",
      type: "fact",
      importance: 0.85,
      source: "test",
      tags: ["alpha"],
    });

    await callTool("memory_recall", { agent_id: agent, query: "Individual" });
    await callTool("memory_recall", { agent_id: agent, query: "Individual" });

    await callTool("memory_consolidate", {
      agent_id: agent,
      min_importance: 0.6,
      min_access_count: 2,
      summarize: false,
    });

    const storePath = join(tmpWorkspace, "agents", agent, "memory-store.json");
    const store = JSON.parse(await readFile(storePath, "utf-8"));
    const ltItems = store.long_term;

    // Items should be promoted individually, no derived_from
    assert.ok(ltItems.length >= 2, "Should have at least 2 individual items");
    const hasConsolidated = ltItems.some((i: any) => i.derived_from && i.derived_from.length > 0);
    assert.ok(!hasConsolidated, "No items should have derived_from when summarize=false");
  });
});

describe("R3: Context-Aware Pre-Compaction Checkpoint", () => {
  const AGENT_ID = "r3-test-agent";

  it("memory_checkpoint creates structured checkpoint file", async () => {
    await callTool("memory_checkpoint", {
      agent_id: AGENT_ID,
      context: "Implementing RLM-inspired memory enhancements",
      decisions: ["Use Jaccard similarity for grouping", "Cap recursive depth at 3"],
      findings: ["TypeDB integration is best-effort", "Materializer auto-indexes via chokidar"],
      next_steps: ["Add tests", "Run integration verification"],
      open_questions: ["Should weekly summaries auto-build on Sundays?"],
    });

    // Find checkpoint file
    const checkpointDir = join(tmpWorkspace, "agents", AGENT_ID, "memory", "checkpoints");
    assert.ok(existsSync(checkpointDir), "Checkpoint directory should exist");

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(checkpointDir);
    const mdFiles = files.filter((f: string) => f.endsWith(".md"));
    assert.ok(mdFiles.length > 0, "Should have at least one checkpoint file");

    const content = await readFile(join(checkpointDir, mdFiles[0]), "utf-8");
    assert.ok(content.includes("# Session Checkpoint"), "Should have checkpoint header");
    assert.ok(content.includes("## Current Task Context"), "Should have context section");
    assert.ok(
      content.includes("Implementing RLM-inspired memory enhancements"),
      "Should contain the context",
    );
    assert.ok(content.includes("## Active Decisions"), "Should have decisions section");
    assert.ok(content.includes("Use Jaccard similarity"), "Should contain a decision");
    assert.ok(content.includes("## Key Findings"), "Should have findings section");
    assert.ok(content.includes("## Next Steps"), "Should have next steps section");
    assert.ok(content.includes("## Open Questions"), "Should have questions section");
  });
});

describe("R4: Recursive Memory Search", () => {
  const AGENT_ID = "r4-test-agent";

  it("memory_recall with recursive_depth=1 discovers indirectly related items", async () => {
    // Store A: related to "market"
    await callTool("memory_store_item", {
      agent_id: AGENT_ID,
      content: "Market analysis shows strong demand in enterprise segment",
      type: "observation",
      importance: 0.7,
      source: "test",
      tags: ["market", "enterprise"],
    });

    // Store B: related to "enterprise" (indirect link to A)
    await callTool("memory_store_item", {
      agent_id: AGENT_ID,
      content: "Enterprise customers prefer annual billing cycles with dedicated support",
      type: "fact",
      importance: 0.6,
      source: "test",
      tags: ["enterprise", "billing"],
    });

    // Store C: related to "billing" (indirect link via B)
    await callTool("memory_store_item", {
      agent_id: AGENT_ID,
      content: "Annual billing revenue projection exceeds monthly by 40%",
      type: "fact",
      importance: 0.65,
      source: "test",
      tags: ["billing", "revenue"],
    });

    // Recursive search starting from "market" should find items beyond direct matches
    const result = await callTool("memory_recall", {
      agent_id: AGENT_ID,
      query: "market",
      recursive_depth: 1,
      store: "all",
    });

    const text = result.content[0].text;
    assert.ok(text.toLowerCase().includes("market analysis"), "Should find direct match");
    // Depth annotation should appear
    assert.ok(text.includes("depth:"), "Should include depth annotations");
  });

  it("memory_recall with recursive_depth=0 behaves like standard search", async () => {
    const result = await callTool("memory_recall", {
      agent_id: AGENT_ID,
      query: "market",
      recursive_depth: 0,
      store: "all",
    });

    const text = result.content[0].text;
    assert.ok(text.includes("market"), "Should find market-related items");
    // Should NOT have depth annotations in non-recursive mode
    assert.ok(!text.includes("depth:"), "Should not have depth annotations for depth=0");
  });
});
