/**
 * Inference Engine — Forward chaining, backward chaining, abductive reasoning
 *
 * Works with the fact store and rule engine to derive new knowledge.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { getTypeDBClient } from "../knowledge/typedb-client.js";
import { InferenceQueries } from "../knowledge/typedb-queries.js";
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

type Fact = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  derived_from?: string[];
  rule_id?: string;
  created_at: string;
  updated_at: string;
  valid_from?: string;
  valid_until?: string;
};

type Rule = {
  id: string;
  name: string;
  type: "inference" | "constraint" | "policy";
  conditions: Array<{ subject?: string; predicate: string; object?: string; variable?: string }>;
  conclusion: { subject?: string; predicate: string; object?: string; variable?: string };
  confidence_factor: number;
  enabled: boolean;
};

function factsPath(api: OpenClawPluginApi, agentId: string) {
  return join(resolveWorkspaceDir(api), "agents", agentId, "facts.json");
}
function rulesPath(api: OpenClawPluginApi, agentId: string) {
  return join(resolveWorkspaceDir(api), "agents", agentId, "rules.json");
}

async function loadFacts(api: OpenClawPluginApi, agentId: string) {
  const store = await readJson(factsPath(api, agentId));
  return (store?.facts || []) as Fact[];
}

async function loadRules(api: OpenClawPluginApi, agentId: string) {
  const store = await readJson(rulesPath(api, agentId));
  return (store?.rules || []) as Rule[];
}

/**
 * Forward chaining: apply rules to existing facts to derive new facts.
 * Continues until no new facts can be derived (fixed-point).
 */
function forwardChain(
  facts: Fact[],
  rules: Rule[],
  maxIterations = 10,
): { newFacts: Fact[]; trace: string[] } {
  const newFacts: Fact[] = [];
  const trace: string[] = [];
  const existingTriples = new Set(facts.map((f) => `${f.subject}|${f.predicate}|${f.object}`));

  for (let iter = 0; iter < maxIterations; iter++) {
    let derived = false;
    const allFacts = [...facts, ...newFacts];

    for (const rule of rules) {
      if (!rule.enabled || rule.type !== "inference") continue;

      // Simple pattern matching: check if all conditions have matching facts
      const bindings = matchConditions(rule.conditions, allFacts);

      for (const binding of bindings) {
        const conclusion = resolveBinding(rule.conclusion, binding);
        const tripleKey = `${conclusion.subject}|${conclusion.predicate}|${conclusion.object}`;

        if (!existingTriples.has(tripleKey)) {
          const supportingFacts = findSupportingFacts(rule.conditions, allFacts, binding);
          const minConfidence = Math.min(...supportingFacts.map((f) => f.confidence));
          const derivedConfidence = minConfidence * rule.confidence_factor;

          const newFact: Fact = {
            id: `F-inf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            subject: conclusion.subject!,
            predicate: conclusion.predicate,
            object: conclusion.object!,
            confidence: Math.round(derivedConfidence * 100) / 100,
            source: "inference",
            derived_from: supportingFacts.map((f) => f.id),
            rule_id: rule.id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };

          newFacts.push(newFact);
          existingTriples.add(tripleKey);
          trace.push(
            `[${rule.id}] ${supportingFacts.map((f) => f.id).join(" + ")} → ${newFact.id}: (${conclusion.subject}, ${conclusion.predicate}, ${conclusion.object}) [${derivedConfidence.toFixed(2)}]`,
          );
          derived = true;
        }
      }
    }

    if (!derived) break;
  }

  return { newFacts, trace };
}

type Binding = Record<string, string>;

function matchConditions(conditions: Rule["conditions"], facts: Fact[]): Binding[] {
  if (conditions.length === 0) return [{}];

  function matchSingle(cond: Rule["conditions"][0], fact: Fact, binding: Binding): Binding | null {
    const b = { ...binding };
    if (cond.predicate && cond.predicate !== fact.predicate) return null;

    if (cond.subject) {
      if (cond.subject.startsWith("?")) {
        if (b[cond.subject] && b[cond.subject] !== fact.subject) return null;
        b[cond.subject] = fact.subject;
      } else if (cond.subject !== fact.subject) return null;
    }

    if (cond.object) {
      if (cond.object.startsWith("?")) {
        if (b[cond.object] && b[cond.object] !== fact.object) return null;
        b[cond.object] = fact.object;
      } else if (cond.object !== fact.object) return null;
    }

    return b;
  }

  function solve(condIdx: number, binding: Binding): Binding[] {
    if (condIdx >= conditions.length) return [binding];
    const results: Binding[] = [];
    for (const fact of facts) {
      const b = matchSingle(conditions[condIdx], fact, binding);
      if (b) results.push(...solve(condIdx + 1, b));
    }
    return results;
  }

  return solve(0, {});
}

function resolveBinding(
  template: Rule["conclusion"],
  binding: Binding,
): { subject: string; predicate: string; object: string } {
  return {
    subject:
      (template.subject?.startsWith("?") ? binding[template.subject] : template.subject) ||
      "unknown",
    predicate: template.predicate,
    object:
      (template.object?.startsWith("?") ? binding[template.object] : template.object) || "unknown",
  };
}

function findSupportingFacts(
  conditions: Rule["conditions"],
  facts: Fact[],
  binding: Binding,
): Fact[] {
  const result: Fact[] = [];
  for (const cond of conditions) {
    const s = cond.subject?.startsWith("?") ? binding[cond.subject] : cond.subject;
    const o = cond.object?.startsWith("?") ? binding[cond.object] : cond.object;
    const match = facts.find(
      (f) => f.predicate === cond.predicate && (!s || f.subject === s) && (!o || f.object === o),
    );
    if (match) result.push(match);
  }
  return result;
}

const ForwardChainParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  max_iterations: Type.Optional(
    Type.Number({ description: "Max inference iterations (default: 10)" }),
  ),
  persist: Type.Optional(
    Type.Boolean({ description: "Save derived facts to store (default: true)" }),
  ),
});

const BackwardChainParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  goal_subject: Type.Optional(Type.String({ description: "Subject to prove" })),
  goal_predicate: Type.String({ description: "Predicate to prove" }),
  goal_object: Type.Optional(Type.String({ description: "Object to prove" })),
  max_depth: Type.Optional(Type.Number({ description: "Max search depth (default: 5)" })),
});

const AbductiveParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  observation: Type.Object(
    {
      subject: Type.String(),
      predicate: Type.String(),
      object: Type.String(),
    },
    { description: "Observed fact to explain" },
  ),
  max_hypotheses: Type.Optional(
    Type.Number({ description: "Max hypotheses to generate (default: 5)" }),
  ),
});

const KnowledgeExplainParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  question: Type.String({ description: "Natural language question to explain" }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal("forward"),
        Type.Literal("backward"),
        Type.Literal("abductive"),
        Type.Literal("auto"),
      ],
      { description: "Reasoning method (default: auto)" },
    ),
  ),
});

export function createInferenceTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "infer_forward",
      label: "Forward Chaining",
      description:
        "Apply inference rules to known facts to derive new conclusions. Runs until fixed-point (no new facts derivable).",
      parameters: ForwardChainParams,
      async execute(_id: string, params: Static<typeof ForwardChainParams>) {
        const facts = await loadFacts(api, params.agent_id);
        const rules = await loadRules(api, params.agent_id);

        // Use TypeDB for condition evaluation when available
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            for (const rule of rules) {
              if (!rule.enabled || rule.type !== "inference") continue;
              for (const cond of rule.conditions) {
                const typeql = InferenceQueries.findMatchingPatterns(
                  params.agent_id,
                  cond.predicate,
                  cond.subject,
                  cond.object,
                );
                await client.matchQuery(
                  typeql,
                  `mabos_${params.agent_id.split("/")[0] || "default"}`,
                );
              }
            }
          }
        } catch {
          // TypeDB unavailable — fall through to file-based inference
        }

        if (facts.length === 0)
          return textResult(`No facts in store for '${params.agent_id}'. Assert facts first.`);
        if (rules.length === 0)
          return textResult(`No rules defined for '${params.agent_id}'. Create rules first.`);

        const { newFacts, trace } = forwardChain(facts, rules, params.max_iterations || 10);

        if (newFacts.length === 0)
          return textResult(
            "Forward chaining complete. No new facts derived (fixed-point reached).",
          );

        // Persist if requested
        if (params.persist !== false) {
          const store = (await readJson(factsPath(api, params.agent_id))) || {
            facts: [],
            version: 0,
          };
          store.facts.push(...newFacts);
          store.version++;
          await writeJson(factsPath(api, params.agent_id), store);
        }

        const traceText = trace.map((t, i) => `${i + 1}. ${t}`).join("\n");
        return textResult(`## Forward Chaining — ${params.agent_id}

**New facts derived:** ${newFacts.length}
**Rules fired:** ${trace.length}
${params.persist !== false ? "**Persisted:** yes" : "**Persisted:** no (dry run)"}

### Inference Trace
${traceText}

### New Facts
${newFacts.map((f) => `- ${f.id}: (${f.subject}, ${f.predicate}, ${f.object}) [${f.confidence}]`).join("\n")}`);
      },
    },

    {
      name: "infer_backward",
      label: "Backward Chaining",
      description:
        "Goal-directed reasoning: prove a statement by finding supporting facts and rules. Identifies knowledge gaps.",
      parameters: BackwardChainParams,
      async execute(_id: string, params: Static<typeof BackwardChainParams>) {
        const facts = await loadFacts(api, params.agent_id);
        const rules = await loadRules(api, params.agent_id);

        // Try TypeDB for path-finding/derivation chain
        try {
          const client = getTypeDBClient();
          if (client.isAvailable()) {
            const typeql = InferenceQueries.proveGoal(
              params.agent_id,
              params.goal_predicate,
              params.goal_subject,
              params.goal_object,
            );
            await client.matchQuery(typeql, `mabos_${params.agent_id.split("/")[0] || "default"}`);
          }
        } catch {
          // TypeDB unavailable — fall through to file-based reasoning
        }

        const goalStr = `(${params.goal_subject || "?"}, ${params.goal_predicate}, ${params.goal_object || "?"})`;

        // Direct fact check
        const directMatch = facts.filter((f) => {
          if (params.goal_predicate && f.predicate !== params.goal_predicate) return false;
          if (params.goal_subject && f.subject !== params.goal_subject) return false;
          if (params.goal_object && f.object !== params.goal_object) return false;
          return true;
        });

        if (directMatch.length > 0) {
          return textResult(`## Backward Chaining — ${params.agent_id}

**Goal:** ${goalStr}
**Status:** ✅ Directly supported

**Supporting facts:**
${directMatch.map((f) => `- ${f.id}: (${f.subject}, ${f.predicate}, ${f.object}) [${f.confidence}, source: ${f.source}]`).join("\n")}`);
        }

        // Find rules that could derive this
        const applicableRules = rules.filter(
          (r) =>
            r.enabled && r.type === "inference" && r.conclusion.predicate === params.goal_predicate,
        );

        if (applicableRules.length === 0) {
          return textResult(`## Backward Chaining — ${params.agent_id}

**Goal:** ${goalStr}
**Status:** ❌ Cannot prove

No facts match and no rules can derive this predicate.

**Knowledge Gap:** Need facts or rules about "${params.goal_predicate}".`);
        }

        // Analyze what's needed
        const analysis = applicableRules.map((rule) => {
          const neededPredicates = rule.conditions.map((c) => c.predicate);
          const satisfied = rule.conditions.filter((c) =>
            facts.some((f) => f.predicate === c.predicate),
          );
          const missing = rule.conditions.filter(
            (c) => !facts.some((f) => f.predicate === c.predicate),
          );
          return { rule, satisfied, missing };
        });

        const output = analysis
          .map((a) => {
            const satText = a.satisfied.map((c) => `    ✅ ${c.predicate}`).join("\n");
            const missText = a.missing.map((c) => `    ❌ ${c.predicate} (NEEDED)`).join("\n");
            return `### Rule: ${a.rule.id} — ${a.rule.name}
  Conditions: ${a.rule.conditions.length} (${a.satisfied.length} satisfied, ${a.missing.length} missing)
${satText}
${missText}`;
          })
          .join("\n\n");

        return textResult(`## Backward Chaining — ${params.agent_id}

**Goal:** ${goalStr}
**Status:** ⚠️ Potentially derivable (gaps exist)

${output}

**To prove this goal, fill the knowledge gaps above.**`);
      },
    },

    {
      name: "infer_abductive",
      label: "Abductive Reasoning",
      description:
        "Generate and rank hypotheses that best explain an observation. Uses rules in reverse.",
      parameters: AbductiveParams,
      async execute(_id: string, params: Static<typeof AbductiveParams>) {
        const facts = await loadFacts(api, params.agent_id);
        const rules = await loadRules(api, params.agent_id);
        const obs = params.observation;
        const maxH = params.max_hypotheses || 5;

        // Find rules whose conclusion matches the observation
        const explanatoryRules = rules.filter(
          (r) => r.enabled && r.conclusion.predicate === obs.predicate,
        );

        // Generate hypotheses from rule conditions
        const hypotheses: Array<{
          rule_id: string;
          rule_name: string;
          conditions: Rule["conditions"];
          supported: number;
          total: number;
          score: number;
        }> = [];

        for (const rule of explanatoryRules) {
          const supported = rule.conditions.filter((c) =>
            facts.some((f) => f.predicate === c.predicate),
          ).length;
          const total = rule.conditions.length;
          const score = total > 0 ? (supported / total) * rule.confidence_factor : 0;

          hypotheses.push({
            rule_id: rule.id,
            rule_name: rule.name,
            conditions: rule.conditions,
            supported,
            total,
            score,
          });
        }

        hypotheses.sort((a, b) => b.score - a.score);
        const topH = hypotheses.slice(0, maxH);

        if (topH.length === 0) {
          return textResult(`## Abductive Reasoning — ${params.agent_id}

**Observation:** (${obs.subject}, ${obs.predicate}, ${obs.object})
**Hypotheses found:** 0

No rules can explain this observation. Consider:
1. Adding rules that could produce "${obs.predicate}"
2. Treating this as a novel observation and asserting it as a base fact`);
        }

        const hText = topH
          .map((h, i) => {
            const condText = h.conditions
              .map((c) => {
                const has = facts.some((f) => f.predicate === c.predicate);
                return `    ${has ? "✅" : "❓"} (${c.subject || "?"}, ${c.predicate}, ${c.object || "?"})`;
              })
              .join("\n");
            return `### Hypothesis ${i + 1}: ${h.rule_name} (score: ${h.score.toFixed(2)})
  Rule: ${h.rule_id}
  Evidence: ${h.supported}/${h.total} conditions supported
${condText}`;
          })
          .join("\n\n");

        return textResult(`## Abductive Reasoning — ${params.agent_id}

**Observation:** (${obs.subject}, ${obs.predicate}, ${obs.object})
**Hypotheses ranked by plausibility:**

${hText}

The highest-scored hypothesis is the best explanation given current evidence.`);
      },
    },

    {
      name: "knowledge_explain",
      label: "Explain Knowledge",
      description:
        "Answer a question by combining fact store queries, inference, and derivation tracing.",
      parameters: KnowledgeExplainParams,
      async execute(_id: string, params: Static<typeof KnowledgeExplainParams>) {
        const facts = await loadFacts(api, params.agent_id);
        const rules = await loadRules(api, params.agent_id);
        const ws = resolveWorkspaceDir(api);
        const kb = await readFile(
          join(ws, "agents", params.agent_id, "Knowledge.md"),
          "utf-8",
        ).catch(() => "");

        return textResult(`## Knowledge Explanation — ${params.agent_id}

**Question:** ${params.question}
**Method:** ${params.method || "auto"}

### Fact Store (${facts.length} facts)
${
  facts
    .slice(0, 20)
    .map(
      (f) =>
        `- (${f.subject}, ${f.predicate}, ${f.object}) [${f.confidence}]${f.derived_from ? " [inferred]" : ""}`,
    )
    .join("\n") || "Empty."
}
${facts.length > 20 ? `\n... and ${facts.length - 20} more` : ""}

### Rules (${rules.length} rules)
${
  rules
    .slice(0, 10)
    .map((r) => `- ${r.id}: ${r.name} (${r.type}, ${r.enabled ? "active" : "disabled"})`)
    .join("\n") || "None."
}

### Knowledge Base
${kb || "No knowledge file."}

**Instructions:**
1. Search facts for relevant triples
2. If method=forward or auto: run forward chaining to derive new facts
3. If method=backward or auto: backward chain from the question to find proofs
4. If method=abductive: generate hypotheses for the question
5. Trace the derivation chain and explain the reasoning
6. State confidence in the answer`);
      },
    },
  ];
}
