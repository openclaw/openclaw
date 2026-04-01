/**
 * CRM & Lead Management Tools — Native lead scoring and deal pipeline
 *
 * Replaces external HubSpot/Salesforce lead scoring and CRM pipeline features
 * with MABOS-native implementations that persist locally.
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
async function writeJson(p: string, d: unknown) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

// ── Parameter Schemas ──────────────────────────────────────────────────

const LeadScoringParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union([Type.Literal("score"), Type.Literal("configure"), Type.Literal("list")], {
    description: "Action: score a lead, configure scoring rules, or list scored leads",
  }),
  lead_data: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      name: Type.String({ description: "Lead name / company" }),
      email: Type.Optional(Type.String()),
      company_size: Type.Optional(
        Type.Union([
          Type.Literal("startup"),
          Type.Literal("smb"),
          Type.Literal("mid_market"),
          Type.Literal("enterprise"),
        ]),
      ),
      industry: Type.Optional(Type.String()),
      budget_range: Type.Optional(Type.String({ description: "e.g. '$5K-$10K'" })),
      engagement_level: Type.Optional(
        Type.Union([
          Type.Literal("cold"),
          Type.Literal("warm"),
          Type.Literal("hot"),
          Type.Literal("engaged"),
        ]),
      ),
      source: Type.Optional(
        Type.String({ description: "Lead source (organic, ad, referral, etc.)" }),
      ),
      last_activity: Type.Optional(
        Type.String({ description: "ISO timestamp of last interaction" }),
      ),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  scoring_rules: Type.Optional(
    Type.Object({
      engagement_weight: Type.Optional(
        Type.Number({ description: "Weight 0-1 for engagement score" }),
      ),
      company_size_weight: Type.Optional(Type.Number()),
      industry_match_weight: Type.Optional(Type.Number()),
      budget_weight: Type.Optional(Type.Number()),
      recency_weight: Type.Optional(Type.Number()),
      target_industries: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

const CrmPipelineParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  action: Type.Union(
    [
      Type.Literal("create_deal"),
      Type.Literal("update_stage"),
      Type.Literal("list_deals"),
      Type.Literal("create_contact"),
      Type.Literal("list_contacts"),
      Type.Literal("pipeline_stats"),
    ],
    { description: "Pipeline action" },
  ),
  data: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      email: Type.Optional(Type.String()),
      company: Type.Optional(Type.String()),
      value: Type.Optional(Type.Number({ description: "Deal value in USD" })),
      stage: Type.Optional(
        Type.Union([
          Type.Literal("prospect"),
          Type.Literal("qualified"),
          Type.Literal("proposal"),
          Type.Literal("negotiation"),
          Type.Literal("closed_won"),
          Type.Literal("closed_lost"),
        ]),
      ),
      contact_id: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

// ── Scoring Logic ──────────────────────────────────────────────────────

const DEFAULT_RULES = {
  engagement_weight: 0.3,
  company_size_weight: 0.2,
  industry_match_weight: 0.2,
  budget_weight: 0.2,
  recency_weight: 0.1,
  target_industries: ["interior_design", "hospitality", "real_estate", "healthcare", "retail"],
};

const ENGAGEMENT_SCORES: Record<string, number> = {
  cold: 10,
  warm: 40,
  hot: 70,
  engaged: 95,
};

const SIZE_SCORES: Record<string, number> = {
  startup: 20,
  smb: 50,
  mid_market: 75,
  enterprise: 95,
};

function scoreLead(
  lead: {
    company_size?: string;
    industry?: string;
    budget_range?: string;
    engagement_level?: string;
    last_activity?: string;
  },
  rules: typeof DEFAULT_RULES,
): { total: number; breakdown: Record<string, number> } {
  const engagement = ENGAGEMENT_SCORES[lead.engagement_level || "cold"] || 10;
  const companySize = SIZE_SCORES[lead.company_size || "smb"] || 50;

  const industryMatch = rules.target_industries.some((ti) =>
    lead.industry?.toLowerCase().includes(ti.toLowerCase()),
  )
    ? 90
    : 30;

  let budget = 50;
  if (lead.budget_range) {
    const nums = lead.budget_range
      .replace(/[^0-9.]/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Boolean);
    const avg = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    if (avg >= 10000) budget = 95;
    else if (avg >= 5000) budget = 75;
    else if (avg >= 1000) budget = 50;
    else budget = 25;
  }

  let recency = 50;
  if (lead.last_activity) {
    const daysSince = (Date.now() - new Date(lead.last_activity).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 1) recency = 100;
    else if (daysSince <= 7) recency = 80;
    else if (daysSince <= 30) recency = 50;
    else recency = 20;
  }

  const breakdown = {
    engagement: Math.round(engagement * rules.engagement_weight),
    company_size: Math.round(companySize * rules.company_size_weight),
    industry_match: Math.round(industryMatch * rules.industry_match_weight),
    budget: Math.round(budget * rules.budget_weight),
    recency: Math.round(recency * rules.recency_weight),
  };

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

const PIPELINE_STAGES = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
];

// ── Tool Factory ───────────────────────────────────────────────────────

export function createCrmTools(api: OpenClawPluginApi): AnyAgentTool[] {
  function leadsPath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "leads.json");
  }
  function pipelinePath(bizId: string) {
    return join(resolveWorkspaceDir(api), "businesses", bizId, "crm-pipeline.json");
  }

  return [
    // ── Lead Scoring ───────────────────────────────────────────────────
    {
      name: "lead_scoring",
      label: "Score & Rank Leads",
      description:
        "Score leads based on configurable criteria: engagement level, company size, industry match, budget range, and recency. " +
        "Replaces HubSpot/Salesforce lead scoring with native MABOS scoring.",
      parameters: LeadScoringParams,
      async execute(_id: string, params: Static<typeof LeadScoringParams>) {
        const store = (await readJson(leadsPath(params.business_id))) || {
          rules: { ...DEFAULT_RULES },
          leads: [],
        };

        if (params.action === "configure" && params.scoring_rules) {
          Object.assign(store.rules, params.scoring_rules);
          await writeJson(leadsPath(params.business_id), store);
          return textResult(`## Lead Scoring Rules Updated

${Object.entries(store.rules)
  .map(([k, v]) => `- **${k}:** ${Array.isArray(v) ? v.join(", ") : v}`)
  .join("\n")}`);
        }

        if (params.action === "list") {
          const leads = store.leads.sort(
            (a: any, b: any) => (b.score?.total ?? 0) - (a.score?.total ?? 0),
          );
          if (leads.length === 0) return textResult("No leads scored yet.");
          const table = leads
            .slice(0, 20)
            .map(
              (l: any, i: number) =>
                `${i + 1}. **${l.name}** — Score: ${l.score?.total ?? "?"} | ${l.engagement_level || "?"} | ${l.company_size || "?"}`,
            )
            .join("\n");
          return textResult(`## Scored Leads (${leads.length} total)\n\n${table}`);
        }

        // score
        if (!params.lead_data) return textResult("Provide `lead_data` to score a lead.");
        const lead = params.lead_data;
        const leadId = lead.id || `LEAD-${Date.now().toString(36)}`;
        const result = scoreLead(lead, store.rules);

        const existing = store.leads.findIndex((l: any) => l.id === leadId);
        const entry = {
          ...lead,
          id: leadId,
          score: result,
          scored_at: new Date().toISOString(),
        };
        if (existing >= 0) store.leads[existing] = entry;
        else store.leads.push(entry);

        await writeJson(leadsPath(params.business_id), store);

        const tier =
          result.total >= 75
            ? "HOT"
            : result.total >= 50
              ? "WARM"
              : result.total >= 25
                ? "COOL"
                : "COLD";
        return textResult(`## Lead Scored: ${lead.name}

**Total Score:** ${result.total}/100 (${tier})
**ID:** ${leadId}

### Breakdown
${Object.entries(result.breakdown)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

**Recommendation:** ${tier === "HOT" ? "Prioritize for immediate outreach" : tier === "WARM" ? "Add to nurture sequence" : "Monitor and re-engage later"}`);
      },
    },

    // ── CRM Pipeline ───────────────────────────────────────────────────
    {
      name: "crm_pipeline",
      label: "CRM Deal Pipeline",
      description:
        "Native deal pipeline and contact management. Tracks deals through stages: " +
        "prospect -> qualified -> proposal -> negotiation -> closed_won/closed_lost. " +
        "Replaces Salesforce/HubSpot CRM features.",
      parameters: CrmPipelineParams,
      async execute(_id: string, params: Static<typeof CrmPipelineParams>) {
        const store = (await readJson(pipelinePath(params.business_id))) || {
          deals: [],
          contacts: [],
          stage_history: [],
        };
        const data = params.data || {};

        switch (params.action) {
          case "create_deal": {
            const deal = {
              id: data.id || `DEAL-${Date.now().toString(36)}`,
              name: data.name || "Untitled Deal",
              value: data.value || 0,
              stage: data.stage || "prospect",
              contact_id: data.contact_id,
              notes: data.notes,
              tags: data.tags || [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            store.deals.push(deal);
            store.stage_history.push({
              deal_id: deal.id,
              from: null,
              to: deal.stage,
              at: deal.created_at,
            });
            await writeJson(pipelinePath(params.business_id), store);
            return textResult(
              `Deal created: **${deal.name}** ($${deal.value}) — Stage: ${deal.stage}\nID: ${deal.id}`,
            );
          }

          case "update_stage": {
            if (!data.id) return textResult("Provide `data.id` for the deal to update.");
            const deal = store.deals.find((d: any) => d.id === data.id);
            if (!deal) return textResult(`Deal ${data.id} not found.`);
            const oldStage = deal.stage;
            deal.stage = data.stage || deal.stage;
            deal.updated_at = new Date().toISOString();
            if (data.notes) deal.notes = data.notes;
            store.stage_history.push({
              deal_id: deal.id,
              from: oldStage,
              to: deal.stage,
              at: deal.updated_at,
            });
            await writeJson(pipelinePath(params.business_id), store);
            return textResult(`Deal **${deal.name}** moved: ${oldStage} -> ${deal.stage}`);
          }

          case "list_deals": {
            if (store.deals.length === 0) return textResult("No deals in pipeline.");
            const byStage: Record<string, any[]> = {};
            for (const d of store.deals) {
              if (!byStage[d.stage]) byStage[d.stage] = [];
              byStage[d.stage].push(d);
            }
            const output = PIPELINE_STAGES.filter((s) => byStage[s]?.length)
              .map((s) => {
                const deals = byStage[s];
                const total = deals.reduce((a: number, d: any) => a + (d.value || 0), 0);
                return `### ${s.toUpperCase()} (${deals.length} deals, $${total.toLocaleString()})\n${deals.map((d: any) => `- **${d.name}** — $${d.value?.toLocaleString() || 0}`).join("\n")}`;
              })
              .join("\n\n");
            return textResult(`## CRM Pipeline — ${params.business_id}\n\n${output}`);
          }

          case "create_contact": {
            const contact = {
              id: data.id || `CONTACT-${Date.now().toString(36)}`,
              name: data.name || "Unknown",
              email: data.email,
              company: data.company,
              tags: data.tags || [],
              created_at: new Date().toISOString(),
            };
            store.contacts.push(contact);
            await writeJson(pipelinePath(params.business_id), store);
            return textResult(
              `Contact created: **${contact.name}** (${contact.email || "no email"})\nID: ${contact.id}`,
            );
          }

          case "list_contacts": {
            if (store.contacts.length === 0) return textResult("No contacts yet.");
            const list = store.contacts
              .slice(0, 20)
              .map(
                (c: any, i: number) =>
                  `${i + 1}. **${c.name}** — ${c.email || "no email"} (${c.company || "?"})`,
              )
              .join("\n");
            return textResult(`## Contacts (${store.contacts.length})\n\n${list}`);
          }

          case "pipeline_stats": {
            const totalDeals = store.deals.length;
            const totalValue = store.deals.reduce((a: number, d: any) => a + (d.value || 0), 0);
            const wonDeals = store.deals.filter((d: any) => d.stage === "closed_won");
            const wonValue = wonDeals.reduce((a: number, d: any) => a + (d.value || 0), 0);
            const lostDeals = store.deals.filter((d: any) => d.stage === "closed_lost");
            const openDeals = store.deals.filter(
              (d: any) => d.stage !== "closed_won" && d.stage !== "closed_lost",
            );
            const openValue = openDeals.reduce((a: number, d: any) => a + (d.value || 0), 0);
            const winRate = totalDeals > 0 ? Math.round((wonDeals.length / totalDeals) * 100) : 0;

            return textResult(`## Pipeline Stats — ${params.business_id}

- **Total Deals:** ${totalDeals}
- **Total Pipeline Value:** $${totalValue.toLocaleString()}
- **Open Deals:** ${openDeals.length} ($${openValue.toLocaleString()})
- **Won:** ${wonDeals.length} ($${wonValue.toLocaleString()})
- **Lost:** ${lostDeals.length}
- **Win Rate:** ${winRate}%
- **Contacts:** ${store.contacts.length}`);
          }

          default:
            return textResult(`Unknown action: ${params.action}`);
        }
      },
    },
  ];
}
