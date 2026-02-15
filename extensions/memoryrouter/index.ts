/**
 * MemoryRouter Plugin for OpenClaw
 *
 * Adds chat commands and hooks for MemoryRouter persistent AI memory.
 * The core routing logic lives in src/agents/memoryrouter-integration.ts
 * and the CLI lives in src/cli/memoryrouter-cli.ts — this plugin adds:
 *
 *   1. Chat command: /memoryrouter (status, enable, disable from any channel)
 *   2. Gateway start hook: log MR status on boot
 *
 * Chat commands:
 *   /memoryrouter                       — Show status
 *   /memoryrouter mk_abc123            — Enable with key
 *   /memoryrouter off                  — Disable
 *   /memoryrouter status               — Detailed status
 *
 * @see https://memoryrouter.ai
 */

import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const MEMORYROUTER_API = "https://api.memoryrouter.ai";
const MEMORYROUTER_HEALTH = `${MEMORYROUTER_API}/health`;
const MEMORYROUTER_STATS = `${MEMORYROUTER_API}/v1/memory/stats`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}...${key.slice(-3)}`;
}

function isValidKeyFormat(key: string): boolean {
  return /^mk[_-]/.test(key);
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

async function pingHealth(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const resp = await fetch(MEMORYROUTER_HEALTH, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>;
      return { ok: true, detail: (data.status as string) ?? "healthy" };
    }
    return { ok: false, detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function fetchVaultStats(
  key: string,
  endpoint?: string,
): Promise<{ memories: number; tokens: number; sessions: number } | null> {
  try {
    const statsUrl = endpoint
      ? `${endpoint.replace(/\/v1$/, "")}/v1/memory/stats`
      : MEMORYROUTER_STATS;
    const resp = await fetch(statsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      totalVectors?: number;
      totalTokens?: number;
      sessions?: number;
    };
    return {
      memories: data.totalVectors ?? 0,
      tokens: data.totalTokens ?? 0,
      sessions: data.sessions ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Plugin Definition ───────────────────────────────────────────────────────

const memoryRouterPlugin = {
  id: "memoryrouter",
  name: "MemoryRouter",
  description: "Chat commands for MemoryRouter persistent AI memory",
  version: "1.0.0",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const { loadConfig, writeConfigFile } = api.runtime.config;

    // ─── Chat Command: /memoryrouter ─────────────────────────────────────────
    // Note: CLI commands (`openclaw memoryrouter <key>`, `off`, `status`, `upload`)
    // are handled by the core at src/cli/memoryrouter-cli.ts.
    // This plugin adds the chat/messaging layer only.
    api.registerCommand({
      name: "memoryrouter",
      description: "MemoryRouter: show status, enable/disable persistent AI memory",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim();
        const mrConfig = (ctx.config as OpenClawConfig).memoryRouter;

        // ── No args or "status": show status ──────────────────────────────────
        if (!args || args === "status") {
          const lines = ["**MemoryRouter Status**", ""];

          lines.push(`Enabled: ${mrConfig?.enabled ? "✓ Yes" : "✗ No"}`);

          if (mrConfig?.key) {
            lines.push(`Key: \`${maskKey(mrConfig.key)}\``);
          }

          const endpoint = mrConfig?.endpoint ?? `${MEMORYROUTER_API}/v1`;
          lines.push(`Endpoint: ${endpoint}`);

          // Fetch vault stats if enabled
          if (mrConfig?.enabled && mrConfig?.key) {
            const stats = await fetchVaultStats(mrConfig.key, mrConfig.endpoint);
            if (stats) {
              lines.push("");
              lines.push("**Vault:**");
              lines.push(`  Memories: ${stats.memories.toLocaleString()}`);
              lines.push(`  Tokens: ${formatTokens(stats.tokens)}`);
              lines.push(`  Sessions: ${stats.sessions}`);
            }
          }

          if (!mrConfig?.enabled) {
            lines.push("");
            lines.push("Enable: `/memoryrouter mk_YOUR_KEY`");
            lines.push("Get a key → https://memoryrouter.ai");
          }

          return { text: lines.join("\n") };
        }

        // ── "off": disable MemoryRouter ───────────────────────────────────────
        if (args === "off") {
          try {
            const cfg = loadConfig();
            if (cfg.memoryRouter) {
              cfg.memoryRouter.enabled = false;
            }
            await writeConfigFile(cfg);
            return { text: "✓ MemoryRouter disabled. Direct provider access restored." };
          } catch {
            return { text: "⚠️ Failed to update config. Try CLI: `openclaw memoryrouter off`" };
          }
        }

        // ── "on": re-enable (if key exists) ───────────────────────────────────
        if (args === "on") {
          if (!mrConfig?.key) {
            return { text: "No key configured. Use: `/memoryrouter mk_YOUR_KEY`" };
          }
          try {
            const cfg = loadConfig();
            if (cfg.memoryRouter) {
              cfg.memoryRouter.enabled = true;
            }
            await writeConfigFile(cfg);
            return { text: "✓ MemoryRouter re-enabled." };
          } catch {
            return { text: "⚠️ Failed to update config." };
          }
        }

        // ── "ping": test API connectivity ─────────────────────────────────────
        if (args === "ping") {
          const health = await pingHealth();
          if (health.ok) {
            return { text: `✓ MemoryRouter API reachable (${health.detail})` };
          }
          return { text: `✗ MemoryRouter API unreachable: ${health.detail}` };
        }

        // ── mk_xxx: enable with key ──────────────────────────────────────────
        if (isValidKeyFormat(args)) {
          try {
            const cfg = loadConfig();
            cfg.memoryRouter = { enabled: true, key: args };
            await writeConfigFile(cfg);

            const health = await pingHealth();
            const apiStatus = health.ok ? "✓ API reachable" : "⚠ API unreachable (will retry)";

            return {
              text: [
                "✓ MemoryRouter enabled!",
                "",
                `Key: \`${maskKey(args)}\``,
                `Endpoint: ${MEMORYROUTER_API}/v1`,
                apiStatus,
                "",
                "All subsequent LLM calls will route through MemoryRouter.",
                "Restart gateway for full effect: `openclaw gateway restart`",
              ].join("\n"),
            };
          } catch {
            return { text: "⚠️ Failed to save config. Try CLI: `openclaw memoryrouter <key>`" };
          }
        }

        // ── Unknown command ───────────────────────────────────────────────────
        return {
          text: [
            "**MemoryRouter Commands:**",
            "",
            "`/memoryrouter` — Show status & vault stats",
            "`/memoryrouter mk_xxx` — Enable with memory key",
            "`/memoryrouter off` — Disable",
            "`/memoryrouter on` — Re-enable",
            "`/memoryrouter ping` — Test API connectivity",
            "",
            "CLI: `openclaw memoryrouter upload` — Upload workspace to vault",
            "CLI: `openclaw memoryrouter delete` — Clear vault",
            "",
            "Get a key → https://memoryrouter.ai",
          ].join("\n"),
        };
      },
    });

    // ─── Gateway Start Hook: log MR status ───────────────────────────────────
    api.on("gateway_start", (event) => {
      const cfg = loadConfig();
      const mr = cfg.memoryRouter;
      if (mr?.enabled && mr?.key) {
        api.logger.info(
          `[memoryrouter] Enabled — key: ${maskKey(mr.key)}, endpoint: ${mr.endpoint ?? MEMORYROUTER_API + "/v1"}`,
        );
      }
    });
  },
};

export default memoryRouterPlugin;
