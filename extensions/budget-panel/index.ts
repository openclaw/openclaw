/**
 * OpenClaw Budget Panel Plugin
 *
 * Multi-provider budget tracking for Claude, Manus, and Gemini.
 * Wired to real usage data.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, existsSync } from "fs";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk";
import { join } from "path";
import { BudgetTracker } from "./src/tracker.js";

export default function register(api: OpenClawPluginApi) {
  const homeDir = process.env.HOME || "/home/globalcaos";
  const workspaceDir =
    (api.config as any)?.agents?.defaults?.workspace || `${homeDir}/.openclaw/workspace`;
  const tracker = new BudgetTracker(workspaceDir);

  // Paths to usage JSON files (hardcoded for reliability)
  const usageFiles = {
    claude: `${homeDir}/.openclaw/workspace/memory/claude-usage.json`,
    gemini: `${homeDir}/.openclaw/workspace/memory/gemini-usage.json`,
    manus: `${homeDir}/.openclaw/workspace/memory/manus-usage.json`,
    chatgpt: `${homeDir}/.openclaw/workspace/memory/chatgpt-usage.json`,
  };

  const log = api.log?.info ?? console.log;
  log(`[budget-panel] Using files: ${JSON.stringify(usageFiles)}`);

  // Helper to safely read JSON files
  function readUsageFile(path: string): Record<string, unknown> | null {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }

  // Load budgets from config
  const config = api.config as Record<string, unknown>;
  const pluginConfig = (config.plugins as Record<string, unknown>)?.["budget-panel"] as
    | Record<string, unknown>
    | undefined;

  if (pluginConfig?.claudeBudget)
    tracker.setProviderBudget("claude", Number(pluginConfig.claudeBudget));
  if (pluginConfig?.manusBudget)
    tracker.setProviderBudget("manus", Number(pluginConfig.manusBudget));
  if (pluginConfig?.geminiBudget)
    tracker.setProviderBudget("gemini", Number(pluginConfig.geminiBudget));

  // Helper to fetch Claude usage from OpenClaw's cost tracking
  async function refreshClaudeUsage(client: any) {
    try {
      // Get current month dates
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

      // Call the usage.cost method internally
      const result = await new Promise<any>((resolve, reject) => {
        if (client?.request) {
          client.request("usage.cost", { startDate, endDate }).then(resolve).catch(reject);
        } else {
          reject(new Error("No client"));
        }
      });

      if (result?.totals?.totalCost !== undefined) {
        tracker.updateUsage("claude", result.totals.totalCost);
      }
    } catch (e) {
      // Silently fail - will show cached/default value
    }
  }

  // Register gateway method: budget.usage (reads real JSON files)
  api.registerGatewayMethod("budget.usage", async ({ respond }) => {
    const claudeData = readUsageFile(usageFiles.claude) as any;
    const geminiData = readUsageFile(usageFiles.gemini) as any;
    const manusData = readUsageFile(usageFiles.manus) as any;
    const chatgptData = readUsageFile(usageFiles.chatgpt) as any;

    const result: Record<string, unknown> = {
      claude: claudeData
        ? {
            mode: claudeData.mode || "subscription",
            plan: claudeData.plan || "max",
            rateLimitTier: claudeData.rateLimitTier || "unknown",
            fetchedAt: claudeData.fetchedAt,
            limits: claudeData.limits || {
              five_hour: { utilization: 0, resets_at: null },
              seven_day: { utilization: 0, resets_at: null },
            },
          }
        : {
            mode: "subscription",
            plan: "max",
            limits: { five_hour: { utilization: 0 }, seven_day: { utilization: 0 } },
          },
      gemini: (() => {
        const models = geminiData?.models || {};
        const result: Record<string, { pct: number; metric: string; used: number; limit: number }> =
          {};
        for (const [key, val] of Object.entries(models) as [string, any][]) {
          const usage = val?.usage || {};
          const limits = val?.limits || {};
          // Calculate percentage for each metric, find the highest
          const metrics = [
            { name: "RPD", used: usage.rpd ?? 0, limit: limits.rpd },
            { name: "RPM", used: usage.rpm ?? 0, limit: limits.rpm },
            { name: "TPM", used: usage.tpm ?? 0, limit: limits.tpm },
          ];
          let maxPct = 0,
            maxMetric = "RPD",
            maxUsed = 0,
            maxLimit = 0;
          for (const m of metrics) {
            if (m.limit && m.limit > 0) {
              const pct = (m.used / m.limit) * 100;
              if (pct > maxPct) {
                maxPct = pct;
                maxMetric = m.name;
                maxUsed = m.used;
                maxLimit = m.limit;
              }
            }
          }
          result[key] = { pct: maxPct, metric: maxMetric, used: maxUsed, limit: maxLimit };
        }
        return result;
      })(),
      manus: (() => {
        if (!manusData)
          return {
            daily: { used: 0, limit: 300, pct: 0 },
            monthly: { used: 0, limit: 4000, pct: 0 },
            addon: 0,
          };
        // Handle manus-usage.json structure (from manus-usage-fetch.py)
        const daily = manusData.credits?.daily_refresh || {};
        const monthly = manusData.credits?.breakdown?.monthly || {};
        // Support both formats: new (daily.used) and legacy (daily.current = remaining)
        const dailyUsed =
          daily.used ?? (daily.limit ? daily.limit - (daily.current ?? daily.limit) : 0);
        const dailyLimit = daily.limit || 300;
        const monthlyUsed = monthly.used || manusData.credits_used || 0;
        const monthlyLimit = monthly.limit || manusData.credits_budget || 4000;
        const addon = manusData.credits?.breakdown?.addon || 0;
        return {
          daily: {
            used: dailyUsed,
            limit: dailyLimit,
            pct: dailyLimit ? (dailyUsed / dailyLimit) * 100 : 0,
          },
          monthly: {
            used: monthlyUsed,
            limit: monthlyLimit,
            pct: monthlyLimit ? (monthlyUsed / monthlyLimit) * 100 : 0,
          },
          addon,
        };
      })(),
    };

    // ChatGPT / OpenAI
    result.chatgpt = (() => {
      if (!chatgptData) return null;
      const models: Record<string, any> = {};
      for (const [key, val] of Object.entries(chatgptData.models || {}) as [string, any][]) {
        const rl = val?.rate_limits || {};
        const limitReq = parseInt(rl.limit_requests) || 0;
        const remainReq = parseInt(rl.remaining_requests) || 0;
        const limitTok = parseInt(rl.limit_tokens) || 0;
        const remainTok = parseInt(rl.remaining_tokens) || 0;
        models[key] = {
          status: val?.status || "unknown",
          utilization_pct: limitReq ? ((limitReq - remainReq) / limitReq) * 100 : 0,
          requests: { used: limitReq - remainReq, limit: limitReq, remaining: remainReq },
          tokens: { used: limitTok - remainTok, limit: limitTok, remaining: remainTok },
        };
      }
      return {
        fetchedAt: chatgptData.fetchedAt,
        api_key_status: chatgptData.api_key_status,
        models,
        plus_limits: chatgptData.plus_subscription_limits || {},
      };
    })();

    respond(true, result, undefined);
  });

  // Register gateway method: budget.status
  api.registerGatewayMethod("budget.status", async ({ respond, client }) => {
    // Get real token usage from OpenClaw's usage.budget
    let claudeData = {
      fiveHourPct: 0,
      dailyPct: 0,
      tier: "max_20x",
      dailyLimit: 6000000,
      fiveHourLimit: 900000,
    };

    try {
      // Call usage.budget internally
      const budgetData = await new Promise<any>((resolve, reject) => {
        const handler = (api as any).gatewayMethods?.get?.("usage.budget");
        if (!handler) {
          reject(new Error("usage.budget not found"));
          return;
        }
        handler({
          respond: (ok: boolean, result: any) => (ok ? resolve(result) : reject(result)),
          params: {},
          client,
        });
      });

      const anthropic = budgetData?.tokenSummaries?.find((s: any) => s.provider === "anthropic");
      if (anthropic?.estimated) {
        claudeData = {
          fiveHourPct: anthropic.estimated.fiveHourPercent || 0,
          dailyPct: anthropic.estimated.dailyPercent || 0,
          tier: anthropic.estimated.tier || "max_20x",
          dailyLimit: anthropic.estimated.dailyLimit || 6000000,
          fiveHourLimit: anthropic.estimated.fiveHourLimit || 900000,
        };
      }
    } catch (e) {
      // console.log("[budget-panel] Could not get usage.budget, using defaults");
    }

    // Build status with real Claude token data
    const manus = tracker.getStatus();
    const providers = [
      {
        name: `Claude (${claudeData.tier})`,
        pct: claudeData.dailyPct,
        used: `${claudeData.dailyPct.toFixed(1)}% daily`,
        remaining: `${(100 - claudeData.dailyPct).toFixed(1)}%`,
        unit: "",
        budget: claudeData.dailyLimit,
      },
      manus.providers.find((p) => p.name === "Manus") || manus.providers[1],
      manus.providers.find((p) => p.name === "Gemini") || manus.providers[2],
    ].filter(Boolean);

    respond(true, { providers, totalPct: claudeData.dailyPct }, undefined);
  });

  // Register gateway method: budget.update (manual updates)
  api.registerGatewayMethod("budget.update", async ({ respond, params }) => {
    const provider = typeof params?.provider === "string" ? params.provider : undefined;
    const used = typeof params?.used === "number" ? params.used : undefined;

    if (!provider || used === undefined) {
      respond(false, undefined, { code: -32602, message: "Missing: provider, used" });
      return;
    }

    tracker.updateUsage(provider, used);
    respond(true, { updated: true, status: tracker.getStatus() }, undefined);
  });

  // Register gateway method: budget.refresh (force refresh from sources)
  api.registerGatewayMethod("budget.refresh", async ({ respond, client }) => {
    if (client) {
      await refreshClaudeUsage(client);
    }
    const status = tracker.getStatus();
    respond(true, status, undefined);
  });

  // Register HTTP route for dashboard
  registerPluginHttpRoute({
    path: "/budget",
    pluginId: "budget-panel",
    handler: async (req, res) => {
      const status = tracker.getStatus();
      const html = generateDashboardHtml(status);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    },
    log: (msg) => log(msg),
  });

  // Register tool for agents (optional)
  if (api.registerTool) {
    api.registerTool(
      () => ({
        name: "budget_check",
        description: "Check multi-provider budget status (Claude, Manus, Gemini)",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          return tracker.getStatus();
        },
      }),
      { optional: true },
    );
  }

  log("[budget-panel] Plugin loaded - dashboard at /budget");
}

function generateDashboardHtml(status: ReturnType<BudgetTracker["getStatus"]>): string {
  const getEmoji = (pct: number) => (pct >= 90 ? "🔴" : pct >= 70 ? "🟠" : pct >= 50 ? "🟡" : "🟢");
  const getColor = (pct: number) =>
    pct >= 90 ? "#ef4444" : pct >= 70 ? "#f97316" : pct >= 50 ? "#eab308" : "#22c55e";

  const providerRows = status.providers
    .map(
      (p) => `
    <div class="provider">
      <div class="provider-header">
        <span class="provider-name">${getEmoji(p.pct)} ${p.name}</span>
        <span class="provider-pct" style="color: ${getColor(p.pct)}">${p.pct.toFixed(1)}%</span>
      </div>
      <div class="bar-container">
        <div class="bar" style="width: ${Math.min(p.pct, 100)}%; background: ${getColor(p.pct)}"></div>
      </div>
      <div class="provider-detail">${p.used} ${p.unit} used · ${p.remaining} ${p.unit} remaining</div>
    </div>
  `,
    )
    .join("");

  const alerts = status.providers
    .filter((p) => p.pct >= 70)
    .map(
      (p) =>
        `<div class="alert" style="border-color: ${getColor(p.pct)}">⚠️ ${p.name} at ${p.pct.toFixed(0)}%</div>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🎛️ Budget Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui; background: #0a0a1a; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .container { max-width: 400px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 24px; font-size: 24px; }
    .panel { background: #1a1a2e; border-radius: 16px; padding: 20px; border: 1px solid #2a2a4a; }
    .provider { margin-bottom: 20px; }
    .provider:last-child { margin-bottom: 0; }
    .provider-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
    .provider-name { font-weight: 600; }
    .provider-pct { font-family: monospace; font-weight: 700; }
    .bar-container { height: 10px; background: #2a2a4a; border-radius: 5px; overflow: hidden; margin-bottom: 6px; }
    .bar { height: 100%; border-radius: 5px; }
    .provider-detail { font-size: 12px; color: #888; }
    .alerts { margin-top: 20px; }
    .alert { background: rgba(255,100,100,0.1); border-left: 3px solid; padding: 10px 12px; margin-bottom: 8px; border-radius: 0 8px 8px 0; font-size: 13px; }
    .refresh { display: block; width: 100%; margin-top: 20px; padding: 12px; background: #2a2a4a; border: none; border-radius: 8px; color: #e0e0e0; cursor: pointer; font-size: 14px; }
    .refresh:hover { background: #3a3a5a; }
    .timestamp { text-align: center; margin-top: 16px; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎛️ Multi-Provider Budget</h1>
    <div class="panel">${providerRows}</div>
    ${alerts ? `<div class="alerts">${alerts}</div>` : ""}
    <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
    <div class="timestamp">Updated: ${new Date().toLocaleString()}</div>
  </div>
  <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
}

export type { BudgetTracker };
