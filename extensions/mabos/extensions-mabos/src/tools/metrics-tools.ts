/**
 * Metrics & Dashboard Tools
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

const MetricsRecordParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  metric_name: Type.String({ description: "Metric name (e.g., 'monthly_revenue', 'cash_runway')" }),
  value: Type.Number({ description: "Metric value" }),
  unit: Type.Optional(Type.String({ description: "Unit (e.g., 'USD', 'days', 'percent')" })),
  period: Type.Optional(Type.String({ description: "Period (e.g., '2026-02', 'Q1-2026')" })),
  source: Type.Optional(
    Type.String({ description: "Data source (e.g., 'stripe', 'manual', 'cfo-report')" }),
  ),
});

const DashboardParams = Type.Object({
  business_id: Type.Optional(
    Type.String({ description: "Business ID, or omit for portfolio view" }),
  ),
  period: Type.Optional(Type.String({ description: "Period to show (default: current month)" })),
});

export function createMetricsTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "metrics_record",
      label: "Record Metric",
      description: "Record a business metric data point (revenue, costs, KPIs, etc.).",
      parameters: MetricsRecordParams,
      async execute(_id: string, params: Static<typeof MetricsRecordParams>) {
        const ws = resolveWorkspaceDir(api);
        const metricsPath = join(ws, "businesses", params.business_id, "metrics.json");
        const data = (await readJson(metricsPath)) || { metrics: [], snapshots: [] };

        data.metrics.push({
          name: params.metric_name,
          value: params.value,
          unit: params.unit || "",
          period: params.period || new Date().toISOString().slice(0, 7),
          source: params.source || "manual",
          recorded_at: new Date().toISOString(),
        });

        await writeJson(metricsPath, data);
        return textResult(
          `Metric recorded: ${params.metric_name} = ${params.value}${params.unit ? ` ${params.unit}` : ""} for ${params.business_id}`,
        );
      },
    },

    {
      name: "metrics_dashboard",
      label: "Metrics Dashboard",
      description: "Generate a stakeholder dashboard view — decisions first, then key metrics.",
      parameters: DashboardParams,
      async execute(_id: string, params: Static<typeof DashboardParams>) {
        const ws = resolveWorkspaceDir(api);

        if (params.business_id) {
          // Single business view
          const bizDir = join(ws, "businesses", params.business_id);
          const manifest = await readJson(join(bizDir, "manifest.json"));
          if (!manifest) return textResult(`Business '${params.business_id}' not found.`);

          const decisions = ((await readJson(join(bizDir, "decision-queue.json"))) || []).filter(
            (d: any) => d.status === "pending",
          );
          const metricsData = (await readJson(join(bizDir, "metrics.json"))) || { metrics: [] };
          const recent = metricsData.metrics.slice(-20);

          let output = `## 📊 Dashboard: ${manifest.name}\n\n`;

          // Decisions first
          output += `### 🔔 Decisions Pending (${decisions.length})\n`;
          if (decisions.length === 0) {
            output += "No pending decisions.\n";
          } else {
            for (const d of decisions) {
              output += `- **${d.id}:** ${d.title} [${d.urgency}]${d.recommendation ? ` — rec: ${d.recommendation}` : ""}\n`;
            }
          }

          // Key metrics
          output += `\n### 📈 Key Metrics\n`;
          if (recent.length === 0) {
            output += "No metrics recorded yet.\n";
          } else {
            const byName = new Map<string, any>();
            for (const m of recent) byName.set(m.name, m);
            for (const [name, m] of byName) {
              output += `- **${name}:** ${m.value}${m.unit ? ` ${m.unit}` : ""} (${m.period})\n`;
            }
          }

          return textResult(output);
        }

        // Portfolio view
        const { readdir } = await import("node:fs/promises");
        const { existsSync } = await import("node:fs");
        const bizRoot = join(ws, "businesses");
        if (!existsSync(bizRoot)) return textResult("No businesses created yet.");

        const dirs = await readdir(bizRoot, { withFileTypes: true });
        let output = "## 📊 Portfolio Dashboard\n\n";
        let totalDecisions = 0;

        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const manifest = await readJson(join(bizRoot, d.name, "manifest.json"));
          if (!manifest || manifest.status !== "active") continue;

          const decisions = (
            (await readJson(join(bizRoot, d.name, "decision-queue.json"))) || []
          ).filter((dec: any) => dec.status === "pending");
          totalDecisions += decisions.length;

          output += `### ${manifest.name} (${manifest.type})\n`;
          output += `- Pending decisions: ${decisions.length}\n`;

          const metricsData = (await readJson(join(bizRoot, d.name, "metrics.json"))) || {
            metrics: [],
          };
          const latest = metricsData.metrics.slice(-5);
          if (latest.length > 0) {
            for (const m of latest) {
              output += `- ${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ""}\n`;
            }
          }
          output += "\n";
        }

        output = `**Total pending decisions: ${totalDecisions}**\n\n` + output;
        return textResult(output);
      },
    },
  ];
}
