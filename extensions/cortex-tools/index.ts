/**
 * Cortex Tools Plugin for Athena.
 *
 * Discovers and registers all Cortex tools (GitHub, Supabase, Vercel,
 * code analysis, security scanning, etc.) as native Athena agent tools.
 *
 * NOTE: Athena's plugin loader does NOT await async register() functions.
 * Tool discovery is done synchronously via a child process to ensure
 * tools are registered before the agent run begins.
 *
 * Configuration (in athena.json or via env vars):
 *   plugins.cortex-tools.url    = "https://cortex.example.com"  (or CORTEX_URL)
 *   plugins.cortex-tools.apiKey = "ctx_..."                     (or CORTEX_API_KEY)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { syncCortexAgents } from "./src/agent-sync.js";
import { CortexClient } from "./src/client.js";
import type { CortexTool } from "./src/client.js";
import { createCortexAgentTool } from "./src/tool-adapter.js";

type CortexPluginConfig = {
  url?: string;
  apiKey?: string;
};

const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

function getCachePath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    ? path.resolve(process.env.OPENCLAW_STATE_DIR)
    : path.join(os.homedir(), ".athena");
  return path.join(stateDir, "cortex-tools-cache.json");
}

function readCachedTools(): CortexTool[] | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) return null;
    const stat = fs.statSync(cachePath);
    if (Date.now() - stat.mtimeMs > CACHE_MAX_AGE_MS) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (Array.isArray(data) && data.length > 0) return data as CortexTool[];
    return null;
  } catch {
    return null;
  }
}

function writeCachedTools(tools: CortexTool[]): void {
  try {
    const cachePath = getCachePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(tools), "utf-8");
  } catch {
    // Best effort
  }
}

/**
 * Synchronously fetch tool schemas from Cortex by spawning a child Node process.
 * This is necessary because Athena's plugin loader does not await async register().
 */
function fetchToolsSync(cortexUrl: string, apiKey: string): CortexTool[] | null {
  const script = [
    "const url = process.env.__CORTEX_DISCOVER_URL;",
    "const key = process.env.__CORTEX_DISCOVER_KEY;",
    "fetch(url, { headers: { 'X-API-Key': key } })",
    "  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })",
    "  .then(d => {",
    "    const tools = Array.isArray(d) ? d : d.tools;",
    "    process.stdout.write(JSON.stringify(tools.map(t => ({",
    "      name: t.name,",
    "      description: t.description,",
    "      inputSchema: t.input_schema",
    "    }))));",
    "  })",
    "  .catch(e => { process.stderr.write(e.message); process.exit(1); });",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    timeout: 15000,
    env: {
      ...process.env,
      __CORTEX_DISCOVER_URL: `${cortexUrl.replace(/\/+$/, "")}/api/v1/tools/schemas`,
      __CORTEX_DISCOVER_KEY: apiKey,
    },
  });

  if (result.status !== 0) return null;
  try {
    const tools = JSON.parse(result.stdout);
    return Array.isArray(tools) ? tools : null;
  } catch {
    return null;
  }
}

const plugin = {
  id: "cortex-tools",
  name: "Cortex Tools",
  description:
    "Connects to Cortex backend and exposes all tools (GitHub, Supabase, Vercel, etc.) as native Athena agent tools",

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as CortexPluginConfig;
    const cortexUrl = pluginConfig.url ?? process.env.CORTEX_URL ?? "";
    const cortexApiKey = pluginConfig.apiKey ?? process.env.CORTEX_API_KEY ?? "";

    if (!cortexUrl || !cortexApiKey) {
      api.logger.warn(
        "Cortex Tools: Missing url or apiKey. Set plugins.cortex-tools.url " +
          "and plugins.cortex-tools.apiKey in config, or CORTEX_URL and CORTEX_API_KEY env vars.",
      );
      return;
    }

    api.logger.info(`Cortex Tools: connecting to ${cortexUrl}`);

    // Try cache first, then synchronous fetch
    let tools = readCachedTools();
    if (tools) {
      api.logger.info(`Cortex Tools: loaded ${tools.length} tools from cache`);
    } else {
      api.logger.info("Cortex Tools: discovering tools from Cortex...");
      tools = fetchToolsSync(cortexUrl, cortexApiKey);
      if (!tools) {
        api.logger.error(
          `Cortex Tools: failed to discover tools from ${cortexUrl}. Is Cortex running?`,
        );
        return;
      }
      api.logger.info(`Cortex Tools: discovered ${tools.length} tools`);
      writeCachedTools(tools);
    }

    // Create the HTTP client for tool execution (used at call time)
    const client = new CortexClient(cortexUrl, cortexApiKey);

    // Register each tool synchronously
    let registered = 0;
    for (const tool of tools) {
      try {
        const agentTool = createCortexAgentTool(tool, client);
        api.registerTool(agentTool as unknown as AnyAgentTool);
        registered++;
      } catch (err) {
        api.logger.warn(
          `Cortex Tools: failed to register tool ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    api.logger.info(`Cortex Tools: registered ${registered}/${tools.length} tools`);

    // Auto-generate one agent per MCP with tool documentation
    try {
      syncCortexAgents(tools, api.logger);
    } catch (err) {
      api.logger.warn(
        `Cortex Tools: agent sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

export default plugin;
