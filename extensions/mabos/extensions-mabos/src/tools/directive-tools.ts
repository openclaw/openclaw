/**
 * Directive Tools — CEO tools for classifying, routing, and decomposing
 * stakeholder directives into agent-assignable sub-goals.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir, generatePrefixedId } from "./common.js";
import {
  classifyDirective,
  classifyWithTropos,
  buildRoutingDecision,
  getAgentLabel,
  type DirectiveClassification,
} from "./directive-router.js";

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

// ── Tool Definitions ─────────────────────────────────────────

const DirectiveClassifyParams = Type.Object({
  directive: Type.String({ description: "The stakeholder directive to classify" }),
  business_id: Type.Optional(
    Type.String({
      description: "Business ID for Tropos goal model enrichment (omit for keyword-only)",
    }),
  ),
});

const DirectiveRouteParams = Type.Object({
  directive: Type.String({ description: "The directive to route" }),
  target_agent: Type.String({
    description: "Agent ID to route to (e.g., cfo, cmo, cto, coo, hr, legal, strategy, knowledge)",
  }),
  method: Type.Optional(
    Type.Union([Type.Literal("request"), Type.Literal("cfp")], {
      description:
        "Dispatch method: 'request' (ACL REQUEST) or 'cfp' (contract-net CFP). Default: request",
    }),
  ),
  priority: Type.Optional(
    Type.Union(
      [Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")],
      { description: "Message priority (default: high)" },
    ),
  ),
  business_id: Type.Optional(Type.String({ description: "Business ID context" })),
});

const DirectiveDecomposeParams = Type.Object({
  directive: Type.String({ description: "The multi-domain directive to decompose" }),
  business_id: Type.Optional(Type.String({ description: "Business ID for Tropos enrichment" })),
  context: Type.Optional(Type.String({ description: "Additional context for decomposition" })),
  budget: Type.Optional(
    Type.Number({ description: "Budget constraint — checked against governance threshold" }),
  ),
  auto_dispatch: Type.Optional(
    Type.Boolean({
      description: "Auto-send REQUEST messages to assigned agents (default: false)",
    }),
  ),
});

export function createDirectiveTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    // ── directive_classify ─────────────────────────────────
    {
      name: "directive_classify",
      label: "Classify Directive",
      description:
        "Classify a stakeholder directive and suggest which C-suite agent should handle it. Returns routing suggestion without dispatching. Use this to check before acting.",
      parameters: DirectiveClassifyParams,
      async execute(_id: string, params: Static<typeof DirectiveClassifyParams>) {
        let classification: DirectiveClassification;
        if (params.business_id) {
          classification = await classifyWithTropos(api, params.business_id, params.directive);
        } else {
          classification = classifyDirective(params.directive);
        }

        const decision = buildRoutingDecision(classification);

        const lines = [
          `## Directive Classification`,
          ``,
          `**Directive:** ${params.directive.slice(0, 200)}`,
          `**Primary Agent:** ${getAgentLabel(decision.primaryAgent)} (${decision.primaryAgent})`,
          `**Confidence:** ${decision.confidence.toFixed(2)}`,
          `**Category:** ${decision.category}`,
          `**Keywords matched:** ${decision.keywords.join(", ") || "none"}`,
          `**Multi-domain:** ${decision.isMultiDomain ? "Yes" : "No"}`,
        ];

        if (decision.secondaryAgents.length > 0) {
          lines.push(
            `**Secondary agents:** ${decision.secondaryAgents.map((a) => getAgentLabel(a)).join(", ")}`,
          );
        }

        lines.push(``, `**Suggested action:** ${decision.suggestedAction}`);
        lines.push(`**Summary:** ${decision.routingSummary}`);

        return textResult(lines.join("\n"));
      },
    },

    // ── directive_route ────────────────────────────────────
    {
      name: "directive_route",
      label: "Route Directive",
      description:
        "Dispatch a directive to a specific agent via ACL REQUEST message or contract-net CFP. Logs the routing for audit trail.",
      parameters: DirectiveRouteParams,
      async execute(_id: string, params: Static<typeof DirectiveRouteParams>) {
        const ws = resolveWorkspaceDir(api);
        const method = params.method || "request";
        const priority = params.priority || "high";
        const now = new Date().toISOString();
        const msgId = `DIR-${Date.now().toString(36)}`;

        if (method === "cfp") {
          // Contract-net: create a CFP record and send to agent
          const cfpId = generatePrefixedId("CFP");
          const cfpPath = join(ws, "contract-net", `${cfpId}.json`);
          const cfp = {
            task_id: cfpId,
            initiator: "ceo",
            description: params.directive,
            candidates: [params.target_agent],
            criteria: ["relevance", "capability"],
            status: "open",
            proposals: [],
            created_at: now,
          };
          await writeJson(cfpPath, cfp);

          const inboxPath = join(ws, "agents", params.target_agent, "inbox.json");
          const inbox = (await readJson(inboxPath)) || [];
          inbox.push({
            id: msgId,
            from: "ceo",
            to: params.target_agent,
            performative: "CFP",
            content: `Call for Proposals: ${params.directive}`,
            priority,
            timestamp: now,
            read: false,
            task_id: cfpId,
          });
          await writeJson(inboxPath, inbox);
        } else {
          // ACL REQUEST
          const inboxPath = join(ws, "agents", params.target_agent, "inbox.json");
          const inbox = (await readJson(inboxPath)) || [];
          inbox.push({
            id: msgId,
            from: "ceo",
            to: params.target_agent,
            performative: "REQUEST",
            content: params.directive,
            priority,
            timestamp: now,
            read: false,
          });
          await writeJson(inboxPath, inbox);
        }

        // Log routing for audit trail
        const logPath = join(ws, "directive-routing-log.json");
        const log = (await readJson(logPath)) || [];
        log.push({
          id: msgId,
          directive: params.directive.slice(0, 500),
          target: params.target_agent,
          method,
          priority,
          business_id: params.business_id,
          timestamp: now,
        });
        // Keep last 500 entries
        if (log.length > 500) log.splice(0, log.length - 500);
        await writeJson(logPath, log);

        return textResult(
          `Directive routed: CEO → ${getAgentLabel(params.target_agent)} [${method.toUpperCase()}] (priority: ${priority})\nMessage ID: ${msgId}`,
        );
      },
    },

    // ── directive_decompose ────────────────────────────────
    {
      name: "directive_decompose",
      label: "Decompose Directive",
      description:
        "Break a multi-domain directive into sub-goals assigned to specific agents. Optionally auto-dispatches REQUEST messages to each agent. Records decomposition plan.",
      parameters: DirectiveDecomposeParams,
      async execute(_id: string, params: Static<typeof DirectiveDecomposeParams>) {
        const ws = resolveWorkspaceDir(api);
        const now = new Date().toISOString();

        // Classify to identify involved agents
        let classification: DirectiveClassification;
        if (params.business_id) {
          classification = await classifyWithTropos(api, params.business_id, params.directive);
        } else {
          classification = classifyDirective(params.directive);
        }

        // Build sub-goals from classification
        const involvedAgents = [
          classification.primaryAgent,
          ...classification.secondaryAgents,
        ].filter((a) => a !== "ceo");

        // If only CEO matched, suggest the directive needs manual decomposition
        if (involvedAgents.length === 0) {
          return textResult(
            `Cannot auto-decompose: no domain agents identified.\n` +
              `The directive "${params.directive.slice(0, 100)}" doesn't match any C-suite domain keywords.\n` +
              `Please manually specify sub-goals or rephrase the directive.`,
          );
        }

        const decompositionId = generatePrefixedId("DEC");
        const subGoals = involvedAgents.map((agent, i) => ({
          id: `${decompositionId}-SG${i + 1}`,
          agent,
          role: i === 0 ? "primary" : "supporting",
          description: `[${getAgentLabel(agent)}] Handle ${agent}-domain aspects of: ${params.directive.slice(0, 200)}`,
          status: "pending",
        }));

        // Check governance threshold if budget provided
        let budgetWarning = "";
        if (params.budget != null) {
          const threshold =
            (((api.pluginConfig ?? {}) as Record<string, unknown>)
              .stakeholderApprovalThresholdUsd as number) || 5000;
          if (params.budget > threshold) {
            budgetWarning = `\n\n**Governance:** Budget $${params.budget} exceeds approval threshold ($${threshold}). Stakeholder approval may be required.`;
          }
        }

        // Save decomposition record
        const decPath = join(ws, "directive-decompositions", `${decompositionId}.json`);
        const record = {
          id: decompositionId,
          directive: params.directive,
          context: params.context,
          budget: params.budget,
          classification,
          subGoals,
          auto_dispatched: params.auto_dispatch || false,
          created_at: now,
        };
        await writeJson(decPath, record);

        // Append to CEO's Plans.md
        const ceoPlansPath = join(ws, "agents", "ceo", "Plans.md");
        let plans = "";
        try {
          plans = await readFile(ceoPlansPath, "utf-8");
        } catch {
          plans = "# CEO Delegation Plans\n";
        }
        const planEntry = [
          `\n## ${decompositionId} — ${params.directive.slice(0, 80)}`,
          `_Created: ${now}_\n`,
          ...subGoals.map(
            (sg) =>
              `- [ ] **${sg.id}** [${sg.role}] ${getAgentLabel(sg.agent)}: ${sg.description.slice(0, 150)}`,
          ),
          budgetWarning ? `\n${budgetWarning.trim()}` : "",
          "",
        ].join("\n");
        await mkdir(dirname(ceoPlansPath), { recursive: true });
        await writeFile(ceoPlansPath, plans + planEntry, "utf-8");

        // Auto-dispatch if requested
        if (params.auto_dispatch) {
          for (const sg of subGoals) {
            const inboxPath = join(ws, "agents", sg.agent, "inbox.json");
            const inbox = (await readJson(inboxPath)) || [];
            inbox.push({
              id: sg.id,
              from: "ceo",
              to: sg.agent,
              performative: "REQUEST",
              content: sg.description,
              priority: sg.role === "primary" ? "high" : "normal",
              timestamp: now,
              read: false,
              decomposition_id: decompositionId,
            });
            await writeJson(inboxPath, inbox);
          }
        }

        // Build response
        const lines = [
          `## Directive Decomposition: ${decompositionId}`,
          ``,
          `**Directive:** ${params.directive.slice(0, 200)}`,
          `**Sub-goals:** ${subGoals.length}`,
          `**Auto-dispatched:** ${params.auto_dispatch ? "Yes" : "No"}`,
          ``,
          ...subGoals.map(
            (sg) =>
              `- **${sg.id}** [${sg.role}] → ${getAgentLabel(sg.agent)}: ${sg.description.slice(0, 120)}`,
          ),
        ];

        if (budgetWarning) lines.push(budgetWarning);
        lines.push(`\nPlan recorded in CEO Plans.md`);

        return textResult(lines.join("\n"));
      },
    },
  ];
}
