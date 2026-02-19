/**
 * Rule Engine — Inference rules, constraint rules, policy rules
 *
 * Three rule types:
 * - Inference: derive new facts from existing facts
 * - Constraint: validate states (flag violations)
 * - Policy: business rules that trigger actions/escalations
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { RuleStoreQueries } from "../knowledge/typedb-queries.js";
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

type ConditionPattern = {
  subject?: string;
  predicate: string;
  object?: string;
  variable?: string;
  operator?: "eq" | "gt" | "lt" | "gte" | "lte" | "ne" | "contains";
};

type Rule = {
  id: string;
  name: string;
  description: string;
  type: "inference" | "constraint" | "policy";
  conditions: ConditionPattern[];
  conclusion?: { subject?: string; predicate: string; object?: string; variable?: string };
  // For constraint rules
  violation_message?: string;
  severity?: "info" | "warning" | "error" | "critical";
  // For policy rules
  action?: string;
  escalate?: boolean;
  // Metadata
  confidence_factor: number;
  enabled: boolean;
  domain?: string;
  created_at: string;
};

function rulesPath(api: OpenClawPluginApi, agentId: string) {
  return join(resolveWorkspaceDir(api), "agents", agentId, "rules.json");
}

const RuleCreateParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  rule_id: Type.String({ description: "Rule ID (e.g., 'R-001')" }),
  name: Type.String({ description: "Rule name" }),
  description: Type.String({ description: "What this rule does" }),
  type: Type.Union(
    [Type.Literal("inference"), Type.Literal("constraint"), Type.Literal("policy")],
    { description: "Rule type" },
  ),
  conditions: Type.Array(
    Type.Object({
      subject: Type.Optional(
        Type.String({ description: "Subject pattern (use ?var for variables)" }),
      ),
      predicate: Type.String({ description: "Predicate to match" }),
      object: Type.Optional(
        Type.String({ description: "Object pattern (use ?var for variables)" }),
      ),
      operator: Type.Optional(
        Type.Union(
          [
            Type.Literal("eq"),
            Type.Literal("gt"),
            Type.Literal("lt"),
            Type.Literal("gte"),
            Type.Literal("lte"),
            Type.Literal("ne"),
            Type.Literal("contains"),
          ],
          { description: "Comparison operator (default: eq)" },
        ),
      ),
    }),
    { description: "Condition patterns — all must match for rule to fire" },
  ),
  conclusion: Type.Optional(
    Type.Object(
      {
        subject: Type.Optional(Type.String()),
        predicate: Type.String(),
        object: Type.Optional(Type.String()),
      },
      { description: "Conclusion triple (for inference rules)" },
    ),
  ),
  violation_message: Type.Optional(
    Type.String({ description: "Message when constraint violated" }),
  ),
  severity: Type.Optional(
    Type.Union([
      Type.Literal("info"),
      Type.Literal("warning"),
      Type.Literal("error"),
      Type.Literal("critical"),
    ]),
  ),
  action: Type.Optional(Type.String({ description: "Action to take (for policy rules)" })),
  escalate: Type.Optional(Type.Boolean({ description: "Escalate to stakeholder (policy rules)" })),
  confidence_factor: Type.Optional(
    Type.Number({ description: "Confidence multiplier for derived facts (default: 0.9)" }),
  ),
  domain: Type.Optional(Type.String({ description: "Business domain this rule applies to" })),
});

const RuleListParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("inference"),
        Type.Literal("constraint"),
        Type.Literal("policy"),
        Type.Literal("all"),
      ],
      { description: "Filter by type (default: all)" },
    ),
  ),
  enabled_only: Type.Optional(
    Type.Boolean({ description: "Only show enabled rules (default: false)" }),
  ),
});

const RuleToggleParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  rule_id: Type.String({ description: "Rule ID to enable/disable" }),
  enabled: Type.Boolean({ description: "Enable or disable" }),
});

const ConstraintCheckParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  domain: Type.Optional(Type.String({ description: "Only check rules for this domain" })),
});

const PolicyEvalParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  context: Type.Record(Type.String(), Type.Unknown(), {
    description: "Current state context for policy evaluation",
  }),
});

export function createRuleEngineTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "rule_create",
      label: "Create Rule",
      description:
        "Create an inference, constraint, or policy rule. Inference rules derive new facts. Constraint rules flag violations. Policy rules trigger actions.",
      parameters: RuleCreateParams,
      async execute(_id: string, params: Static<typeof RuleCreateParams>) {
        const path = rulesPath(api, params.agent_id);
        const store = (await readJson(path)) || { rules: [], version: 0 };

        const existing = store.rules.findIndex((r: Rule) => r.id === params.rule_id);
        const rule: Rule = {
          id: params.rule_id,
          name: params.name,
          description: params.description,
          type: params.type,
          conditions: params.conditions as ConditionPattern[],
          conclusion: params.conclusion,
          violation_message: params.violation_message,
          severity: params.severity,
          action: params.action,
          escalate: params.escalate,
          confidence_factor: params.confidence_factor ?? 0.9,
          enabled: true,
          domain: params.domain,
          created_at: new Date().toISOString(),
        };

        if (existing !== -1) {
          store.rules[existing] = rule;
        } else {
          store.rules.push(rule);
        }
        store.version++;

        await writeJson(path, store);

        // Write-through to TypeDB (best-effort)
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = RuleStoreQueries.createRule(params.agent_id, {
              id: params.rule_id,
              name: params.name,
              description: params.description,
              type: params.type,
              conditionCount: params.conditions.length,
              confidenceFactor: params.confidence_factor ?? 0.9,
              enabled: true,
              domain: params.domain,
            });
            await client.insertData(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — JSON is source of truth
        }

        return textResult(
          `Rule ${params.rule_id} ${existing !== -1 ? "updated" : "created"}: "${params.name}" (${params.type}, ${params.conditions.length} conditions)`,
        );
      },
    },

    {
      name: "rule_list",
      label: "List Rules",
      description: "List all rules for an agent, optionally filtered by type.",
      parameters: RuleListParams,
      async execute(_id: string, params: Static<typeof RuleListParams>) {
        // Try TypeDB first (exercise connection), fall back to JSON
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = RuleStoreQueries.listRules(params.agent_id, params.type || undefined);
            await client.matchQuery(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // Fall through to JSON
        }

        const store = (await readJson(rulesPath(api, params.agent_id))) || { rules: [] };
        let rules = store.rules as Rule[];

        const type = params.type || "all";
        if (type !== "all") rules = rules.filter((r) => r.type === type);
        if (params.enabled_only) rules = rules.filter((r) => r.enabled);

        if (rules.length === 0)
          return textResult(`No ${type} rules found for '${params.agent_id}'.`);

        const grouped: Record<string, Rule[]> = {};
        for (const r of rules) {
          (grouped[r.type] ||= []).push(r);
        }

        let output = `## Rules — ${params.agent_id}\n\n`;
        for (const [t, rs] of Object.entries(grouped)) {
          output += `### ${t.charAt(0).toUpperCase() + t.slice(1)} Rules (${rs.length})\n`;
          for (const r of rs) {
            output += `- **${r.id}:** ${r.name} ${r.enabled ? "" : "[DISABLED]"}`;
            output += ` — ${r.conditions.length} conditions`;
            if (r.type === "constraint") output += ` [${r.severity || "warning"}]`;
            if (r.type === "policy" && r.escalate) output += ` [escalates]`;
            output += `\n  ${r.description}\n`;
          }
          output += "\n";
        }

        return textResult(output);
      },
    },

    {
      name: "rule_toggle",
      label: "Toggle Rule",
      description: "Enable or disable a rule.",
      parameters: RuleToggleParams,
      async execute(_id: string, params: Static<typeof RuleToggleParams>) {
        const path = rulesPath(api, params.agent_id);
        const store = (await readJson(path)) || { rules: [], version: 0 };
        const rule = store.rules.find((r: Rule) => r.id === params.rule_id);

        if (!rule) return textResult(`Rule '${params.rule_id}' not found.`);

        rule.enabled = params.enabled;
        store.version++;
        await writeJson(path, store);

        // Sync toggle to TypeDB (best-effort)
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = RuleStoreQueries.toggleRule(
              params.agent_id,
              params.rule_id,
              params.enabled,
            );
            await client.deleteData(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable
        }

        return textResult(`Rule ${params.rule_id} ${params.enabled ? "enabled" : "disabled"}.`);
      },
    },

    {
      name: "constraint_check",
      label: "Check Constraints",
      description: "Evaluate all constraint rules against current facts. Returns violations.",
      parameters: ConstraintCheckParams,
      async execute(_id: string, params: Static<typeof ConstraintCheckParams>) {
        const facts = ((await readJson(factsPath(api, params.agent_id)))?.facts || []) as any[];
        const rules = ((await readJson(rulesPath(api, params.agent_id)))?.rules || []) as Rule[];

        const constraints = rules.filter(
          (r) =>
            r.enabled && r.type === "constraint" && (!params.domain || r.domain === params.domain),
        );

        if (constraints.length === 0) return textResult("No constraint rules to check.");

        const violations: Array<{ rule: Rule; message: string }> = [];

        for (const rule of constraints) {
          // A constraint is violated when its conditions ARE met (the bad state exists)
          const allMatch = rule.conditions.every((cond) =>
            facts.some((f) => {
              if (cond.predicate !== f.predicate) return false;
              if (cond.subject && !cond.subject.startsWith("?") && cond.subject !== f.subject)
                return false;
              if (cond.object && !cond.object.startsWith("?")) {
                if (cond.operator === "gt") return parseFloat(f.object) > parseFloat(cond.object);
                if (cond.operator === "lt") return parseFloat(f.object) < parseFloat(cond.object);
                if (cond.operator === "gte") return parseFloat(f.object) >= parseFloat(cond.object);
                if (cond.operator === "lte") return parseFloat(f.object) <= parseFloat(cond.object);
                if (cond.operator === "ne") return f.object !== cond.object;
                return f.object === cond.object;
              }
              return true;
            }),
          );

          if (allMatch) {
            violations.push({
              rule,
              message:
                rule.violation_message || `Constraint ${rule.id} violated: ${rule.description}`,
            });
          }
        }

        if (violations.length === 0)
          return textResult(`✅ All ${constraints.length} constraints satisfied.`);

        const output = violations
          .map((v) => {
            const icon =
              v.rule.severity === "critical"
                ? "🔴"
                : v.rule.severity === "error"
                  ? "🟠"
                  : v.rule.severity === "warning"
                    ? "🟡"
                    : "ℹ️";
            return `${icon} **${v.rule.id}** [${v.rule.severity || "warning"}]: ${v.message}`;
          })
          .join("\n");

        return textResult(`## Constraint Violations — ${params.agent_id}

**${violations.length} violation(s) found:**

${output}`);
      },
    },

    {
      name: "policy_eval",
      label: "Evaluate Policies",
      description:
        "Evaluate policy rules against current context. Returns triggered policies and required actions.",
      parameters: PolicyEvalParams,
      async execute(_id: string, params: Static<typeof PolicyEvalParams>) {
        const facts = ((await readJson(factsPath(api, params.agent_id)))?.facts || []) as any[];
        const rules = ((await readJson(rulesPath(api, params.agent_id)))?.rules || []) as Rule[];

        const policies = rules.filter((r) => r.enabled && r.type === "policy");
        if (policies.length === 0) return textResult("No policy rules defined.");

        return textResult(`## Policy Evaluation — ${params.agent_id}

**Context:**
\`\`\`json
${JSON.stringify(params.context, null, 2)}
\`\`\`

**Facts in store:** ${facts.length}
**Policy rules:** ${policies.length}

${policies
  .map(
    (p) => `### ${p.id}: ${p.name}
- Conditions: ${p.conditions.map((c) => `(${c.subject || "?"}, ${c.predicate}, ${c.object || "?"})`).join(", ")}
- Action: ${p.action || "none"}
- Escalates: ${p.escalate ? "yes" : "no"}
- Description: ${p.description}`,
  )
  .join("\n\n")}

**Evaluate each policy against the context and facts. For triggered policies, execute the specified action.**`);
      },
    },
  ];
}

function factsPath(api: OpenClawPluginApi, agentId: string) {
  return join(resolveWorkspaceDir(api), "agents", agentId, "facts.json");
}
