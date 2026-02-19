/**
 * Reporting Tools — Financial, operational, strategic reports
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}
async function readMd(p: string) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}
async function writeMd(p: string, c: string) {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, c, "utf-8");
}

const ReportGenerateParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  type: Type.Union(
    [
      Type.Literal("financial"),
      Type.Literal("operational"),
      Type.Literal("strategic"),
      Type.Literal("portfolio"),
      Type.Literal("agent_performance"),
      Type.Literal("contractor_utilization"),
    ],
    { description: "Report type" },
  ),
  period: Type.Optional(
    Type.String({ description: "Period (e.g., '2026-02', 'Q1-2026', 'weekly')" }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("summary"), Type.Literal("detailed"), Type.Literal("executive")], {
      description: "Report format (default: summary)",
    }),
  ),
});

const LegalEntityParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  entity_type: Type.Optional(Type.String({ description: "Entity type (LLC, Corp, etc.)" })),
  formation_state: Type.Optional(Type.String({ description: "State/country of formation" })),
  ein: Type.Optional(Type.String({ description: "EIN / Tax ID" })),
  licenses: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        number: Type.Optional(Type.String()),
        expires: Type.Optional(Type.String()),
        jurisdiction: Type.Optional(Type.String()),
      }),
    ),
  ),
  compliance_items: Type.Optional(
    Type.Array(
      Type.Object({
        item: Type.String(),
        due_date: Type.Optional(Type.String()),
        status: Type.Union([
          Type.Literal("compliant"),
          Type.Literal("pending"),
          Type.Literal("overdue"),
        ]),
      }),
    ),
  ),
});

const FinancialPipelineParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([
    Type.Literal("setup_coa"),
    Type.Literal("record_transaction"),
    Type.Literal("reconcile"),
    Type.Literal("tax_calendar"),
  ]),
  data: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Action-specific data" }),
  ),
});

export function createReportingTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "report_generate",
      label: "Generate Report",
      description:
        "Generate a business report — financial, operational, strategic, portfolio, agent performance, or contractor utilization.",
      parameters: ReportGenerateParams,
      async execute(_id: string, params: Static<typeof ReportGenerateParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const now = new Date().toISOString();
        const period = params.period || now.slice(0, 7);
        const format = params.format || "summary";

        // Gather data
        const manifest = await readJson(join(bizDir, "manifest.json"));
        if (!manifest && params.type !== "portfolio")
          return textResult(`Business '${params.business_id}' not found.`);

        const metrics = (await readJson(join(bizDir, "metrics.json")))?.metrics || [];
        const decisions = (await readJson(join(bizDir, "decision-queue.json"))) || [];
        const wpStore = (await readJson(join(bizDir, "work-packages.json")))?.packages || [];

        if (params.type === "financial") {
          const financial = metrics.filter((m: any) =>
            ["revenue", "costs", "profit", "cash", "runway", "burn_rate", "mrr", "arr"].some((k) =>
              m.name?.toLowerCase().includes(k),
            ),
          );

          return textResult(`## 💰 Financial Report — ${manifest?.name || params.business_id}
**Period:** ${period} | **Format:** ${format}

### Key Financial Metrics
${financial.length > 0 ? financial.map((m: any) => `- **${m.name}:** ${m.value}${m.unit ? ` ${m.unit}` : ""} (${m.period || "latest"})`).join("\n") : "No financial metrics recorded. Use `metrics_record` to add data."}

### Pending Financial Decisions
${
  decisions
    .filter((d: any) => d.status === "pending" && d.agent === "cfo")
    .map((d: any) => `- ${d.id}: ${d.title} [${d.urgency}]`)
    .join("\n") || "None."
}

### Work Package Costs
${
  wpStore
    .filter((w: any) => w.budget_usd)
    .map((w: any) => `- ${w.id}: ${w.title} — $${w.budget_usd} [${w.status}]`)
    .join("\n") || "No budgeted work packages."
}

${
  format === "detailed"
    ? `### Recommendations
Analyze the financial metrics and provide:
1. Cash flow trend (improving/declining)
2. Burn rate assessment
3. Key risks
4. Action items for CFO`
    : ""
}`);
        }

        if (params.type === "operational") {
          const pending = decisions.filter((d: any) => d.status === "pending").length;
          const activeWp = wpStore.filter((w: any) =>
            ["assigned", "in_progress"].includes(w.status),
          );

          return textResult(`## ⚙️ Operational Report — ${manifest?.name || params.business_id}
**Period:** ${period}

### Decision Queue
- Pending: ${pending}
- Resolved this period: ${decisions.filter((d: any) => d.status !== "pending").length}

### Work Packages
- Active: ${activeWp.length}
- Completed: ${wpStore.filter((w: any) => w.status === "completed").length}
- Total: ${wpStore.length}

### Agent Activity
${(manifest?.agents || []).map((a: string) => `- **${a.toUpperCase()}**: Active`).join("\n")}

### Operational Metrics
${
  metrics
    .filter(
      (m: any) => !["revenue", "costs", "profit"].some((k) => m.name?.toLowerCase().includes(k)),
    )
    .slice(-10)
    .map((m: any) => `- ${m.name}: ${m.value}${m.unit ? ` ${m.unit}` : ""}`)
    .join("\n") || "No operational metrics."
}`);
        }

        if (params.type === "strategic") {
          const togaf = await readJson(join(bizDir, "togaf-architecture.json"));
          const tropos = await readJson(join(bizDir, "tropos-goal-model.json"));
          const bmc = await readJson(join(bizDir, "business-model-canvas.json"));

          return textResult(`## 🎯 Strategic Report — ${manifest?.name || params.business_id}
**Period:** ${period}

### Business Model
${bmc ? `Value Props: ${bmc.canvas?.value_propositions?.join(", ") || "TBD"}\nSegments: ${bmc.canvas?.customer_segments?.join(", ") || "TBD"}\nRevenue: ${bmc.canvas?.revenue_streams?.join(", ") || "TBD"}` : "No BMC generated."}

### Strategic Goals
${tropos ? tropos.goal_mapping?.map((g: any) => `- "${g.stakeholder_goal}" → ${g.primary_agent.toUpperCase()} (priority: ${g.priority})`).join("\n") : "No Tropos model."}

### Architecture
${togaf ? `Stage: ${togaf.business_architecture?.stage}\nAgents: ${togaf.business_architecture?.organizational_structure?.agents?.length || 0}` : "No TOGAF model."}

### Strategic Decisions Pending
${
  decisions
    .filter((d: any) => d.status === "pending" && d.urgency === "critical")
    .map((d: any) => `- 🔴 ${d.id}: ${d.title}`)
    .join("\n") || "None critical."
}`);
        }

        if (params.type === "portfolio") {
          const bizRoot = join(ws, "businesses");
          if (!existsSync(bizRoot)) return textResult("No businesses exist yet.");

          const dirs = await readdir(bizRoot, { withFileTypes: true });
          let totalDecisions = 0;
          let totalWp = 0;
          const businesses: string[] = [];

          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const m = await readJson(join(bizRoot, d.name, "manifest.json"));
            if (!m) continue;
            const decs = (await readJson(join(bizRoot, d.name, "decision-queue.json"))) || [];
            const wps =
              (await readJson(join(bizRoot, d.name, "work-packages.json")))?.packages || [];
            const pending = decs.filter((x: any) => x.status === "pending").length;
            totalDecisions += pending;
            totalWp += wps.length;
            businesses.push(
              `### ${m.name} (${m.type}) — ${m.status}\n- Decisions pending: ${pending}\n- Work packages: ${wps.length}`,
            );
          }

          return textResult(`## 🏢 Portfolio Report
**Date:** ${now.split("T")[0]}
**Businesses:** ${businesses.length}
**Total pending decisions:** ${totalDecisions}
**Total work packages:** ${totalWp}

${businesses.join("\n\n")}`);
        }

        if (params.type === "agent_performance") {
          const agentList = manifest?.agents || [];
          const agentStats: string[] = [];

          for (const role of agentList) {
            const agentDir = join(bizDir, "agents", role);
            const goals = await readMd(join(agentDir, "Goals.md"));
            const intentions = await readMd(join(agentDir, "Intentions.md"));
            const inbox = (await readJson(join(agentDir, "inbox.json"))) || [];
            const cases = (await readJson(join(agentDir, "cases.json"))) || [];
            const unread = inbox.filter((m: any) => !m.read).length;

            agentStats.push(
              `- **${role.toUpperCase()}**: ${unread} unread, ${cases.length} cases stored`,
            );
          }

          return textResult(`## 🤖 Agent Performance — ${manifest?.name}
**Period:** ${period}

${agentStats.join("\n")}`);
        }

        if (params.type === "contractor_utilization") {
          const pool = (await readJson(join(ws, "contractor-pool.json")))?.contractors || [];
          const active = pool.filter((c: any) => c.active_packages.length > 0);
          const available = pool.filter((c: any) => c.availability === "available");

          return textResult(`## 👷 Contractor Utilization
**Date:** ${now.split("T")[0]}

- **Total pool:** ${pool.length}
- **Active:** ${active.length}
- **Available:** ${available.length}
- **Avg trust score:** ${pool.length > 0 ? (pool.reduce((s: number, c: any) => s + c.trust_score, 0) / pool.length).toFixed(2) : "N/A"}

### Active Contractors
${active.map((c: any) => `- **${c.name}** (${c.id}) — trust: ${c.trust_score.toFixed(2)}, packages: ${c.active_packages.join(", ")}`).join("\n") || "None."}

### Top Performers (by trust)
${
  pool
    .sort((a: any, b: any) => b.trust_score - a.trust_score)
    .slice(0, 5)
    .map((c: any) => `- ${c.name}: ${c.trust_score.toFixed(2)} (${c.completed_packages} completed)`)
    .join("\n") || "None."
}`);
        }

        return textResult("Unknown report type.");
      },
    },

    {
      name: "legal_entity_manage",
      label: "Manage Legal Entity",
      description:
        "Manage legal entity data — formation docs, licenses, compliance tracking, tax IDs.",
      parameters: LegalEntityParams,
      async execute(_id: string, params: Static<typeof LegalEntityParams>) {
        const ws = resolveWorkspaceDir(api);
        const path = join(ws, "businesses", params.business_id, "legal-entity.json");
        const existing = (await readJson(path)) || {};

        const entity = {
          ...existing,
          business_id: params.business_id,
          entity_type: params.entity_type || existing.entity_type,
          formation_state: params.formation_state || existing.formation_state,
          ein: params.ein || existing.ein,
          licenses: params.licenses || existing.licenses || [],
          compliance_items: params.compliance_items || existing.compliance_items || [],
          updated_at: new Date().toISOString(),
        };

        await writeJson(path, entity);

        const overdue = entity.compliance_items.filter((c: any) => c.status === "overdue");
        const expiring = entity.licenses.filter((l: any) => {
          if (!l.expires) return false;
          const days = (new Date(l.expires).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
          return days < 30 && days > 0;
        });

        return textResult(`Legal entity updated for ${params.business_id}.
${params.entity_type ? `- Type: ${params.entity_type}` : ""}
${params.formation_state ? `- Formation: ${params.formation_state}` : ""}
${params.ein ? `- EIN: ${params.ein}` : ""}
- Licenses: ${entity.licenses.length}
- Compliance items: ${entity.compliance_items.length}
${overdue.length ? `\n⚠️ **${overdue.length} overdue compliance item(s):**\n${overdue.map((c: any) => `- ${c.item} (due: ${c.due_date})`).join("\n")}` : ""}
${expiring.length ? `\n⏰ **${expiring.length} license(s) expiring within 30 days:**\n${expiring.map((l: any) => `- ${l.name} (expires: ${l.expires})`).join("\n")}` : ""}`);
      },
    },

    {
      name: "financial_pipeline",
      label: "Financial Data Pipeline",
      description:
        "Manage financial data — chart of accounts, transactions, reconciliation, tax calendar.",
      parameters: FinancialPipelineParams,
      async execute(_id: string, params: Static<typeof FinancialPipelineParams>) {
        const ws = resolveWorkspaceDir(api);
        const bizDir = join(ws, "businesses", params.business_id);
        const finPath = join(bizDir, "financials.json");
        const fin = (await readJson(finPath)) || {
          chart_of_accounts: [],
          transactions: [],
          tax_calendar: [],
        };

        if (params.action === "setup_coa") {
          const defaultCoa = [
            { code: "1000", name: "Cash", type: "asset" },
            { code: "1100", name: "Accounts Receivable", type: "asset" },
            { code: "2000", name: "Accounts Payable", type: "liability" },
            { code: "3000", name: "Owner's Equity", type: "equity" },
            { code: "4000", name: "Revenue", type: "revenue" },
            { code: "5000", name: "Cost of Goods Sold", type: "expense" },
            { code: "6000", name: "Operating Expenses", type: "expense" },
            { code: "6100", name: "Marketing", type: "expense" },
            { code: "6200", name: "Technology", type: "expense" },
            { code: "6300", name: "Contractor Payments", type: "expense" },
            { code: "6400", name: "Legal & Professional", type: "expense" },
          ];
          fin.chart_of_accounts = params.data?.accounts || defaultCoa;
          await writeJson(finPath, fin);
          return textResult(
            `Chart of accounts set up with ${fin.chart_of_accounts.length} accounts.`,
          );
        }

        if (params.action === "record_transaction") {
          const tx = {
            id: `TX-${Date.now().toString(36)}`,
            ...(params.data as any),
            recorded_at: new Date().toISOString(),
          };
          fin.transactions.push(tx);
          await writeJson(finPath, fin);
          return textResult(`Transaction ${tx.id} recorded.`);
        }

        if (params.action === "reconcile") {
          const unreconciled = fin.transactions.filter((t: any) => !t.reconciled);
          return textResult(
            `## Reconciliation — ${params.business_id}\n\nUnreconciled transactions: ${unreconciled.length}\nTotal transactions: ${fin.transactions.length}\n\nReview each unreconciled transaction and match against bank records.`,
          );
        }

        if (params.action === "tax_calendar") {
          const defaultCalendar = [
            { item: "Quarterly estimated taxes", due: "Q+15 days", frequency: "quarterly" },
            {
              item: "Annual tax return",
              due: "March 15 (partnerships) / April 15 (corps)",
              frequency: "annual",
            },
            { item: "1099 filing", due: "January 31", frequency: "annual" },
            {
              item: "Sales tax remittance",
              due: "Varies by jurisdiction",
              frequency: "monthly/quarterly",
            },
          ];
          fin.tax_calendar = params.data?.calendar || defaultCalendar;
          await writeJson(finPath, fin);
          return textResult(
            `Tax calendar set up with ${fin.tax_calendar.length} items:\n${fin.tax_calendar.map((t: any) => `- ${t.item} — ${t.due} (${t.frequency})`).join("\n")}`,
          );
        }

        return textResult("Unknown financial action.");
      },
    },
  ];
}
