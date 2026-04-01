/**
 * Directive Router — Keyword-based classification of stakeholder directives
 * to C-suite agents. Zero API cost for basic classification; optional Tropos
 * enrichment when goal model is available.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveWorkspaceDir } from "./common.js";

// ── Types ────────────────────────────────────────────────────

export interface DirectiveClassification {
  primaryAgent: string;
  secondaryAgents: string[];
  confidence: number;
  category: string;
  keywords: string[];
  isMultiDomain: boolean;
}

export interface RoutingDecision extends DirectiveClassification {
  suggestedAction: "delegate" | "decompose" | "handle_directly";
  routingSummary: string;
}

// ── Keyword Map ──────────────────────────────────────────────

interface AgentKeywordEntry {
  agent: string;
  label: string;
  keywords: string[];
}

const AGENT_KEYWORD_MAP: AgentKeywordEntry[] = [
  {
    agent: "cfo",
    label: "CFO (Finance)",
    keywords: [
      "revenue",
      "profit",
      "cost",
      "cash",
      "financ",
      "budget",
      "invoice",
      "payment",
      "pricing",
      "margin",
    ],
  },
  {
    agent: "cmo",
    label: "CMO (Marketing & Sales)",
    keywords: [
      "customer",
      "market",
      "brand",
      "campaign",
      "seo",
      "social",
      "content",
      "lead",
      "subscriber",
      "audience",
      "prospect",
      "outreach",
      "pipeline",
      "deal",
      "nurture",
      "conversion",
      "sales",
      "cold",
      "warm",
      "follow-up",
      "qualify",
      "apollo",
      "google maps",
    ],
  },
  {
    agent: "cto",
    label: "CTO (Technology)",
    keywords: [
      "tech",
      "platform",
      "build",
      "deploy",
      "architect",
      "api",
      "database",
      "infrastructure",
      "code",
      "devops",
    ],
  },
  {
    agent: "coo",
    label: "COO (Operations)",
    keywords: [
      "operation",
      "process",
      "efficien",
      "supply",
      "logistics",
      "fulfillment",
      "shipping",
      "inventory",
      "order",
    ],
  },
  {
    agent: "hr",
    label: "HR (Human Resources)",
    keywords: ["team", "hire", "talent", "recruit", "onboard", "culture", "payroll", "benefit"],
  },
  {
    agent: "legal",
    label: "Legal & Compliance",
    keywords: [
      "legal",
      "compliance",
      "regulat",
      "contract",
      "trademark",
      "privacy",
      "gdpr",
      "license",
    ],
  },
  {
    agent: "strategy",
    label: "Strategy",
    keywords: ["strateg", "compet", "vision", "roadmap", "pivot", "growth", "expansion", "partner"],
  },
  {
    agent: "knowledge",
    label: "Knowledge Management",
    keywords: ["ontolog", "knowledge", "taxonomy", "schema", "typedb", "reasoning", "inference"],
  },
];

// ── Classification ───────────────────────────────────────────

/**
 * Classify a directive using keyword matching. Zero API cost.
 * Returns scored agent assignments with confidence bounded [0.3, 0.95].
 */
export function classifyDirective(prompt: string): DirectiveClassification {
  const lower = prompt.toLowerCase();
  const scores: { agent: string; label: string; hits: string[] }[] = [];

  for (const entry of AGENT_KEYWORD_MAP) {
    const hits = entry.keywords.filter((kw) => lower.includes(kw));
    if (hits.length > 0) {
      scores.push({ agent: entry.agent, label: entry.label, hits });
    }
  }

  // Sort by number of keyword hits (descending)
  scores.sort((a, b) => b.hits.length - a.hits.length);

  if (scores.length === 0) {
    return {
      primaryAgent: "ceo",
      secondaryAgents: [],
      confidence: 0.3,
      category: "general",
      keywords: [],
      isMultiDomain: false,
    };
  }

  const primary = scores[0];
  const secondary = scores.slice(1).map((s) => s.agent);
  const isMultiDomain = scores.length >= 2 && scores[1].hits.length >= 2;

  // Confidence: more hits = higher confidence, capped at 0.95
  const rawConf = Math.min(0.95, 0.3 + primary.hits.length * 0.15);

  return {
    primaryAgent: primary.agent,
    secondaryAgents: secondary,
    confidence: rawConf,
    category: primary.label,
    keywords: primary.hits,
    isMultiDomain,
  };
}

/**
 * Enriched classification using Tropos goal model when available.
 * Falls back to keyword-only classification if goal model is missing.
 */
export async function classifyWithTropos(
  api: OpenClawPluginApi,
  businessId: string,
  prompt: string,
): Promise<DirectiveClassification> {
  const base = classifyDirective(prompt);
  const ws = resolveWorkspaceDir(api);

  try {
    const goalModelPath = join(ws, "businesses", businessId, "tropos-goal-model.json");
    const raw = await readFile(goalModelPath, "utf-8");
    const goalModel = JSON.parse(raw);

    if (!goalModel?.goals || !Array.isArray(goalModel.goals)) return base;

    // Match directive against goal model entries to refine agent assignment
    const lower = prompt.toLowerCase();
    for (const goal of goalModel.goals) {
      const goalText = (goal.description || goal.name || "").toLowerCase();
      // Check if the directive relates to a specific goal
      const overlap = goalText
        .split(/\s+/)
        .filter((w: string) => w.length > 3 && lower.includes(w));
      if (overlap.length >= 2 && goal.assignedAgent) {
        // Goal model has a stronger signal — boost confidence
        if (goal.assignedAgent === base.primaryAgent) {
          base.confidence = Math.min(0.95, base.confidence + 0.1);
        } else if (!base.secondaryAgents.includes(goal.assignedAgent)) {
          base.secondaryAgents.push(goal.assignedAgent);
          base.isMultiDomain = true;
        }
      }
    }
  } catch {
    // Goal model unavailable — use keyword-only classification
  }

  return base;
}

// ── Routing Decision Builder ─────────────────────────────────

/**
 * Build a routing decision from a classification.
 * Determines whether to delegate, decompose, or handle directly.
 */
export function buildRoutingDecision(classification: DirectiveClassification): RoutingDecision {
  let suggestedAction: RoutingDecision["suggestedAction"];

  if (classification.isMultiDomain) {
    suggestedAction = "decompose";
  } else if (classification.primaryAgent === "ceo") {
    suggestedAction = "handle_directly";
  } else {
    suggestedAction = "delegate";
  }

  const agentLabel =
    AGENT_KEYWORD_MAP.find((e) => e.agent === classification.primaryAgent)?.label ||
    classification.primaryAgent.toUpperCase();

  let routingSummary: string;
  if (suggestedAction === "decompose") {
    const agents = [classification.primaryAgent, ...classification.secondaryAgents]
      .map((a) => AGENT_KEYWORD_MAP.find((e) => e.agent === a)?.label || a.toUpperCase())
      .join(", ");
    routingSummary = `Multi-domain directive spanning ${agents}. Consider using directive_decompose to break into sub-goals.`;
  } else if (suggestedAction === "delegate") {
    routingSummary = `Suggested routing: ${agentLabel} (confidence: ${classification.confidence.toFixed(2)}, keywords: ${classification.keywords.join(", ")})`;
  } else {
    routingSummary = `No strong agent match — CEO should handle directly or clarify intent.`;
  }

  return {
    ...classification,
    suggestedAction,
    routingSummary,
  };
}

/**
 * Get the label for an agent ID.
 */
export function getAgentLabel(agentId: string): string {
  return AGENT_KEYWORD_MAP.find((e) => e.agent === agentId)?.label || agentId.toUpperCase();
}
