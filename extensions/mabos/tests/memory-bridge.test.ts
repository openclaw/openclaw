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
    const memoryMdPath = join(tmpWorkspace, "agents", AGENT_ID, "Memory.md");
    assert.ok(existsSync(memoryMdPath), "Memory.md (title case) should still exist");

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
