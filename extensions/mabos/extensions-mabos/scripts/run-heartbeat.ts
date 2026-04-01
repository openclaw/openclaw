#!/usr/bin/env node
/**
 * Standalone Heartbeat Runner
 *
 * Triggers the enhanced heartbeat cycle outside the gateway process.
 * Useful for debugging, testing, and one-off runs.
 *
 * Usage:
 *   bun run scripts/run-heartbeat.ts [--workspace <path>] [--init-skills] [--agents cfo,cmo]
 *   node --import tsx scripts/run-heartbeat.ts [--workspace <path>]
 *
 * Environment:
 *   ANTHROPIC_API_KEY or OPENAI_API_KEY — required for LLM calls
 *   MABOS_WORKSPACE — workspace directory (default: ~/.openclaw/workspace)
 */

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ── Parse args ──────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (flag: string) => args.includes(flag);

const workspaceDir =
  getArg("--workspace") || process.env.MABOS_WORKSPACE || join(homedir(), ".openclaw", "workspace");

const initSkills = hasFlag("--init-skills");
const filterAgents = getArg("--agents")?.split(",");

console.log(`[run-heartbeat] workspace: ${workspaceDir}`);

// ── Minimal API mock ────────────────────────────────────────────

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

interface MockApi {
  config: Record<string, unknown>;
  runtime: {
    modelAuth: {
      resolveApiKeyForProvider: (opts: {
        provider: string;
        cfg: unknown;
      }) => Promise<{ apiKey: string } | null>;
    };
  };
  pluginConfig: Record<string, unknown>;
  getSkillSnapshot: (opts: { workspaceDir: string }) => {
    skills: Array<{ name: string; primaryEnv?: string }>;
  };
}

const api: MockApi = {
  config: {
    agents: { defaults: { workspace: workspaceDir } },
    workspaceDir,
  },
  runtime: {
    modelAuth: {
      async resolveApiKeyForProvider({ provider }: { provider: string }) {
        if (provider === "anthropic" && anthropicKey) return { apiKey: anthropicKey };
        if (provider === "openai" && openaiKey) return { apiKey: openaiKey };
        return null;
      },
    },
  },
  pluginConfig: {},
  getSkillSnapshot: () => ({ skills: [] }),
};

// ── Helpers ─────────────────────────────────────────────────────

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(p: string, c: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}

// ── Init Skills ─────────────────────────────────────────────────

async function initSkillsForAllAgents(): Promise<void> {
  const agentsDir = join(workspaceDir, "agents");
  let agentIds: string[];

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    agentIds = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    console.error("[init-skills] No agents directory found at", agentsDir);
    return;
  }

  if (filterAgents) {
    agentIds = agentIds.filter((id) => filterAgents.includes(id));
  }

  let availableTools: string[] = [];
  try {
    const toolFiles = await readdir(join(workspaceDir, "tools"));
    availableTools = toolFiles
      .filter((f) => f.endsWith(".json") || f.endsWith(".ts") || f.endsWith(".js"))
      .map((f) => f.replace(/\.(json|ts|js)$/, ""));
  } catch {
    // No tools directory
  }

  for (const agentId of agentIds) {
    const dir = join(agentsDir, agentId);
    const caps = await readMd(join(dir, "Capabilities.md"));
    const now = new Date().toISOString();

    const capLines = caps
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    const capRows = capLines.map((cap, i) => {
      const toolMatch = availableTools.find((t) => cap.toLowerCase().includes(t.toLowerCase()));
      return `| SK-${String(i + 1).padStart(3, "0")} | ${cap} | ${toolMatch || "—"} | active |`;
    });

    const content = `# Skills — ${agentId}

Last inventoried: ${now}

## Skill Registry

| ID | Skill | Tools | Status |
|---|---|---|---|
${capRows.join("\n")}

## Notes

Skills auto-populated from Capabilities.md by \`run-heartbeat --init-skills\`.
Available workspace tools: ${availableTools.length > 0 ? availableTools.join(", ") : "none detected"}
`;

    await writeMd(join(dir, "Skill.md"), content);
    console.log(
      `[init-skills] Initialized skills for ${agentId} (${capLines.length} capabilities)`,
    );
  }

  console.log(`[init-skills] Done: ${agentIds.length} agent(s) initialized`);
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (initSkills) {
    await initSkillsForAllAgents();
    return;
  }

  if (!anthropicKey && !openaiKey) {
    console.warn(
      "[run-heartbeat] WARNING: No ANTHROPIC_API_KEY or OPENAI_API_KEY set. LLM calls will be skipped (reflexive only).",
    );
  }

  // Import heartbeat dynamically
  const { enhancedHeartbeatCycle } = await import("../src/tools/cognitive-router.js");

  const log = {
    info: (...a: unknown[]) => console.log("[heartbeat]", ...a),
    debug: (...a: unknown[]) => console.log("[heartbeat]", ...a),
    warn: (...a: unknown[]) => console.warn("[heartbeat]", ...a),
  };

  console.log(`[run-heartbeat] Starting heartbeat cycle...`);
  const start = Date.now();

  await enhancedHeartbeatCycle(workspaceDir, api as any, log);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[run-heartbeat] Heartbeat complete in ${elapsed}s`);
}

main().catch((err) => {
  console.error("[run-heartbeat] Fatal:", err);
  process.exit(1);
});
