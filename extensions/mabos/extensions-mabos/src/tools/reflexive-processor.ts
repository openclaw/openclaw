/**
 * Reflexive Processor — System 1 (zero LLM calls)
 *
 * Six-stage pipeline that handles routine processing purely through
 * pattern matching, rule evaluation, and threshold monitoring.
 * No API calls means zero token cost for reflexive-depth cycles.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ReflexiveInput,
  ReflexiveOutcome,
  ReflexiveAction,
  ReflexiveEscalation,
  CognitiveSignal,
} from "./cognitive-router-types.js";
import { generatePrefixedId } from "./common.js";
import {
  matchConditions,
  resolveBinding,
  findSupportingFacts,
  matchConditionToFact,
  type Fact,
  type Rule,
} from "./pattern-matching.js";

// ── File I/O ──────────────────────────────────────────────────

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

// ── Role-specific threshold predicates ────────────────────────

const ROLE_WATCH_PREDICATES: Record<
  string,
  { predicate: string; threshold: string; operator: string; label: string }[]
> = {
  cfo: [
    {
      predicate: "hasBudgetUtilization",
      threshold: "0.90",
      operator: "gt",
      label: "Budget >90% utilized",
    },
    {
      predicate: "hasCashFlowRatio",
      threshold: "1.0",
      operator: "lt",
      label: "Cash flow ratio <1.0",
    },
    { predicate: "hasGrossMargin", threshold: "0.20", operator: "lt", label: "Gross margin <20%" },
    {
      predicate: "hasRevenueGrowth",
      threshold: "-0.05",
      operator: "lt",
      label: "Revenue declining >5%",
    },
  ],
  coo: [
    {
      predicate: "hasFulfillmentRate",
      threshold: "0.95",
      operator: "lt",
      label: "Fulfillment <95%",
    },
    { predicate: "hasBacklogSize", threshold: "100", operator: "gt", label: "Backlog >100 items" },
    {
      predicate: "hasInventoryTurnover",
      threshold: "2.0",
      operator: "lt",
      label: "Inventory turnover <2.0",
    },
    {
      predicate: "hasOrderDeliveryRate",
      threshold: "0.90",
      operator: "lt",
      label: "On-time delivery <90%",
    },
  ],
  cmo: [
    { predicate: "hasCampaignROI", threshold: "1.0", operator: "lt", label: "Campaign ROI <1.0" },
    { predicate: "hasConversionRate", threshold: "0.02", operator: "lt", label: "Conversion <2%" },
    { predicate: "hasChurnRate", threshold: "0.05", operator: "gt", label: "Churn >5%" },
    { predicate: "hasCAC", threshold: "100", operator: "gt", label: "CAC >$100" },
  ],
  cto: [
    { predicate: "hasSystemUptime", threshold: "0.999", operator: "lt", label: "Uptime <99.9%" },
    {
      predicate: "hasDeployFrequency",
      threshold: "1",
      operator: "lt",
      label: "Deploy frequency <1/week",
    },
    { predicate: "hasTechDebtScore", threshold: "7", operator: "gt", label: "Tech debt score >7" },
  ],
  ceo: [
    {
      predicate: "hasCompanyValuation",
      threshold: "0",
      operator: "lt",
      label: "Valuation declining",
    },
    {
      predicate: "hasStakeholderSatisfaction",
      threshold: "0.6",
      operator: "lt",
      label: "Stakeholder satisfaction <60%",
    },
  ],
};

// ── Main Processor ────────────────────────────────────────────

/**
 * Run the reflexive (System 1) processor. Pure function with zero LLM calls.
 *
 * Six stages:
 * 1. Inbox message processing (CBR + keyword classification)
 * 2. Forward chaining inference
 * 3. Constraint checking
 * 4. Policy evaluation
 * 5. Goal maintenance
 * 6. Role-specific threshold monitoring
 */
export async function runReflexiveProcessing(input: ReflexiveInput): Promise<ReflexiveOutcome> {
  const { agentId, agentDir, role, signals } = input;
  const actions: ReflexiveAction[] = [];
  const escalations: ReflexiveEscalation[] = [];
  const stats = {
    inboxProcessed: 0,
    factsInferred: 0,
    constraintViolations: 0,
    policiesTriggered: 0,
    goalsChecked: 0,
    thresholdAlerts: 0,
  };

  // Load agent data
  const factStore = (await readJson(join(agentDir, "facts.json"))) || { facts: [], version: 0 };
  const ruleStore = (await readJson(join(agentDir, "rules.json"))) || { rules: [] };
  const caseLibrary = (await readJson(join(agentDir, "case-library.json"))) || { cases: [] };
  const facts = (factStore.facts || []) as Fact[];
  const rules = (ruleStore.rules || []) as Rule[];

  // ── Stage 1: Inbox Message Processing ──────────────────────

  const inboxSignals = signals.filter((s) => s.source === "inbox");
  for (const sig of inboxSignals) {
    stats.inboxProcessed++;
    const meta = sig.metadata as { performative: string; from: string; messageId: string };

    // CBR: check case library for similar past messages
    let caseMatched = false;
    if (caseLibrary.cases && Array.isArray(caseLibrary.cases)) {
      for (const c of caseLibrary.cases) {
        if (c.problem && typeof c.problem === "string") {
          const similarity = computeSimpleSimilarity(sig.summary, c.problem);
          if (similarity > 0.8 && c.solution) {
            actions.push({
              type: "log_action",
              description: `CBR match (${(similarity * 100).toFixed(0)}%): reuse solution from case ${c.id || "unknown"}`,
              data: { caseId: c.id, similarity, solution: c.solution },
            });
            caseMatched = true;
            break;
          }
        }
      }
    }

    // Classify directive by performative (case-insensitive)
    if (!caseMatched) {
      const perf = (meta.performative || "").toUpperCase();
      if (perf === "INFORM") {
        actions.push({
          type: "assert_fact",
          description: `Process inform from ${meta.from}`,
          data: { messageId: meta.messageId, from: meta.from, type: "inbox_inform" },
        });
      } else if (perf === "REQUEST" || perf === "DIRECTIVE" || perf === "QUERY" || perf === "CFP") {
        // Requests, queries, and directives need deeper processing
        escalations.push({
          reason: `${meta.performative} from ${meta.from} requires deliberation`,
          severity: "info",
          source: `inbox:${meta.messageId}`,
        });
      }
    }
  }

  // ── Stage 2: Forward Chaining Inference ────────────────────

  const inferenceRules = rules.filter((r) => r.enabled && r.type === "inference");
  if (inferenceRules.length > 0 && facts.length > 0) {
    const existingTriples = new Set(facts.map((f) => `${f.subject}|${f.predicate}|${f.object}`));
    let allFacts = [...facts];

    for (let iter = 0; iter < 10; iter++) {
      let derived = false;
      for (const rule of inferenceRules) {
        if (!rule.conclusion) continue;
        const bindings = matchConditions(rule.conditions, allFacts);

        for (const binding of bindings) {
          const conclusion = resolveBinding(rule.conclusion, binding);
          const tripleKey = `${conclusion.subject}|${conclusion.predicate}|${conclusion.object}`;

          if (!existingTriples.has(tripleKey)) {
            const supporting = findSupportingFacts(rule.conditions, allFacts, binding);
            const minConf =
              supporting.length > 0 ? Math.min(...supporting.map((f) => f.confidence)) : 0.5;
            const derivedConf = Math.round(minConf * rule.confidence_factor * 100) / 100;

            actions.push({
              type: "assert_fact",
              description: `Inferred: (${conclusion.subject}, ${conclusion.predicate}, ${conclusion.object}) via ${rule.id}`,
              data: {
                subject: conclusion.subject,
                predicate: conclusion.predicate,
                object: conclusion.object,
                confidence: derivedConf,
                ruleId: rule.id,
                derivedFrom: supporting.map((f) => f.id),
              },
            });

            existingTriples.add(tripleKey);
            // Add to working set for further chaining
            allFacts.push({
              id: generatePrefixedId("INF"),
              subject: conclusion.subject,
              predicate: conclusion.predicate,
              object: conclusion.object,
              confidence: derivedConf,
              source: "inference",
              derived_from: supporting.map((f) => f.id),
              rule_id: rule.id,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            stats.factsInferred++;
            derived = true;
          }
        }
      }
      if (!derived) break;
    }
  }

  // ── Stage 3: Constraint Checking ───────────────────────────

  const constraintRules = rules.filter((r) => r.enabled && r.type === "constraint");
  for (const rule of constraintRules) {
    const allMatch = rule.conditions.every((cond) =>
      facts.some((f) => matchConditionToFact(cond, f)),
    );

    if (allMatch) {
      stats.constraintViolations++;
      const severity = rule.severity || "warning";
      const message = rule.violation_message || `Constraint ${rule.id} violated: ${rule.name}`;

      actions.push({
        type: "log_action",
        description: `Constraint violation [${severity}]: ${message}`,
        data: { ruleId: rule.id, severity, message },
      });

      if (severity === "critical" || severity === "error") {
        escalations.push({
          reason: message,
          severity,
          source: `constraint:${rule.id}`,
        });
      }
    }
  }

  // ── Stage 4: Policy Evaluation ─────────────────────────────

  const policyRules = rules.filter((r) => r.enabled && r.type === "policy");
  for (const rule of policyRules) {
    const allMatch = rule.conditions.every((cond) =>
      facts.some((f) => matchConditionToFact(cond, f)),
    );

    if (allMatch) {
      stats.policiesTriggered++;

      if (rule.action) {
        actions.push({
          type: "log_action",
          description: `Policy ${rule.id} triggered: ${rule.action}`,
          data: { ruleId: rule.id, action: rule.action, escalate: rule.escalate },
        });
      }

      if (rule.escalate) {
        escalations.push({
          reason: `Policy ${rule.id} requires escalation: ${rule.name}`,
          severity: "warning",
          source: `policy:${rule.id}`,
        });
      }
    }
  }

  // ── Stage 5: Goal Maintenance ──────────────────────────────

  const goalSignals = signals.filter((s) => s.source === "goal_state" || s.source === "deadline");
  for (const sig of goalSignals) {
    stats.goalsChecked++;

    if (sig.urgency >= 0.8) {
      escalations.push({
        reason: sig.summary,
        severity: sig.urgency >= 0.95 ? "critical" : "error",
        source: `${sig.source}:${sig.id}`,
      });
    } else if (sig.urgency >= 0.5) {
      actions.push({
        type: "log_action",
        description: sig.summary,
        data: { signalId: sig.id, source: sig.source, urgency: sig.urgency },
      });
    }
  }

  // ── Stage 6: Role-Specific Threshold Monitoring ────────────

  const watchPredicates = ROLE_WATCH_PREDICATES[role] || [];
  for (const watch of watchPredicates) {
    const matchingFacts = facts.filter((f) => f.predicate === watch.predicate);
    for (const fact of matchingFacts) {
      const factVal = parseFloat(fact.object);
      const threshVal = parseFloat(watch.threshold);
      if (isNaN(factVal) || isNaN(threshVal)) continue;

      let violated = false;
      switch (watch.operator) {
        case "gt":
          violated = factVal > threshVal;
          break;
        case "lt":
          violated = factVal < threshVal;
          break;
        case "gte":
          violated = factVal >= threshVal;
          break;
        case "lte":
          violated = factVal <= threshVal;
          break;
        default:
          violated = false;
      }

      if (violated) {
        stats.thresholdAlerts++;
        actions.push({
          type: "log_action",
          description: `Threshold alert: ${watch.label} (actual: ${fact.object})`,
          data: {
            predicate: watch.predicate,
            actual: fact.object,
            threshold: watch.threshold,
            operator: watch.operator,
          },
        });

        // Critical thresholds escalate
        if (factVal > threshVal * 1.5 || factVal < threshVal * 0.5) {
          escalations.push({
            reason: `Critical threshold: ${watch.label} (actual: ${fact.object}, threshold: ${watch.threshold})`,
            severity: "error",
            source: `threshold:${watch.predicate}`,
          });
        }
      }
    }
  }

  // ── Compute Confidence ─────────────────────────────────────

  let confidence = 0.7; // Base confidence for reflexive processing
  // Boost by case match ratio
  const caseActions = actions.filter((a) => a.data.caseId);
  if (inboxSignals.length > 0 && caseActions.length > 0) {
    confidence += 0.1 * (caseActions.length / inboxSignals.length);
  }
  // Penalize by escalation count
  confidence -= escalations.length * 0.05;
  // Penalize by critical violations
  const criticalCount = escalations.filter((e) => e.severity === "critical").length;
  confidence -= criticalCount * 0.1;
  // Clamp
  confidence = Math.max(0.1, Math.min(0.95, confidence));

  return { actions, escalations, confidence, stats };
}

// ── Utilities ─────────────────────────────────────────────────

/**
 * Simple word-overlap similarity for CBR matching.
 * Returns 0-1 score based on Jaccard similarity of word sets.
 */
function computeSimpleSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  return intersection / (wordsA.size + wordsB.size - intersection);
}
