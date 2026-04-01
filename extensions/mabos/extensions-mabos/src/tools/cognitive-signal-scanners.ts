/**
 * Cognitive Signal Scanners — Seven data-source scanners that emit CognitiveSignals
 *
 * Each scanner reads one data source (inbox, observations, facts, goals, rules,
 * policies, deadlines) and produces normalized signals with urgency/stakes/novelty
 * scores for the cognitive router's demand computation.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CognitiveSignal,
  InboxSignalMeta,
  ObservationSignalMeta,
  FactChangeSignalMeta,
  GoalStateSignalMeta,
  RuleViolationSignalMeta,
  PolicyTriggerSignalMeta,
  DeadlineSignalMeta,
} from "./cognitive-router-types.js";
import { generatePrefixedId } from "./common.js";
import { matchConditionToFact, type Fact, type Rule } from "./pattern-matching.js";

// ── File I/O ──────────────────────────────────────────────────

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

// ── Urgency Normalization ─────────────────────────────────────

const URGENCY_MAP: Record<string, Record<string, number>> = {
  inbox: { urgent: 0.9, high: 0.75, normal: 0.4, low: 0.2, routine: 0.1 },
  observation: { critical: 0.9, important: 0.6, routine: 0.1, info: 0.05 },
  fact_change: { contradiction: 0.85, confidence_drop: 0.6, new: 0.3 },
  goal_state: {
    failing: 0.9,
    blocked: 0.7,
    deadline_approaching: 0.8,
    activated: 0.4,
    achieved: 0.1,
  },
  rule_violation: { critical: 1.0, error: 0.8, warning: 0.5, info: 0.2 },
  policy_trigger: { escalate: 0.85, action: 0.5, notify: 0.3 },
  deadline: { expired: 1.0, hours_3: 0.9, hours_24: 0.7, hours_72: 0.5, days_7: 0.3 },
};

function normalizeUrgency(source: string, level: string): number {
  return URGENCY_MAP[source]?.[level] ?? 0.3;
}

// ── 1. Inbox Scanner ──────────────────────────────────────────

interface InboxMessage {
  id: string;
  from: string;
  to: string;
  performative: string;
  subject?: string;
  content?: string;
  body?: string;
  priority?: string;
  timestamp: string;
  read?: boolean;
}

export async function scanInbox(
  agentDir: string,
  agentId: string,
  _since: string,
): Promise<CognitiveSignal[]> {
  const raw = await readJson(join(agentDir, "inbox.json"));
  // Handle both flat array [...] and wrapped { messages: [...] } formats
  const messages: InboxMessage[] = Array.isArray(raw) ? raw : raw?.messages || [];
  if (messages.length === 0) return [];

  // Rely on read flag only — timestamp filter caused permanent message skip
  // when first heartbeat ran with buggy code and set lastHeartbeatAt
  const unread = messages.filter((m) => !m.read);

  // Cap at 20 signals per cycle to avoid flooding from large backlogs
  const capped = unread
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(0, 20);

  return capped.map((msg) => {
    const priority = msg.priority || "normal";
    const urgency = normalizeUrgency("inbox", priority);
    // Higher stakes for directives from supervisors (case-insensitive)
    const perf = (msg.performative || "").toUpperCase();
    const stakes =
      perf === "REQUEST" || perf === "DIRECTIVE" || perf === "QUERY" || perf === "CFP" ? 0.7 : 0.4;
    const novelty = 0.5; // Default; could be refined with CBR similarity

    const meta: InboxSignalMeta = {
      source: "inbox",
      messageId: msg.id,
      from: msg.from,
      performative: msg.performative,
    };

    return {
      id: generatePrefixedId("SIG"),
      source: "inbox" as const,
      agentId,
      timestamp: msg.timestamp,
      summary: `Inbox: ${msg.performative} from ${msg.from} — ${msg.subject || msg.content?.slice(0, 80) || "(no subject)"}`,
      urgency,
      stakes,
      novelty,
      metadata: meta,
    };
  });
}

// ── 2. Observation Scanner ────────────────────────────────────

interface Observation {
  id: string;
  content: string;
  category?: string;
  importance?: string;
  timestamp: string;
}

export async function scanObservations(
  agentDir: string,
  agentId: string,
  since: string,
): Promise<CognitiveSignal[]> {
  const log = (await readJson(join(agentDir, "observation-log.json"))) as {
    observations?: Observation[];
  } | null;
  if (!log?.observations) return [];

  const sinceTime = new Date(since).getTime();
  const recent = log.observations.filter((o) => new Date(o.timestamp).getTime() > sinceTime);

  return recent.map((obs) => {
    const importance = obs.importance || "routine";
    const urgency = normalizeUrgency("observation", importance);
    const stakes = importance === "critical" ? 0.8 : importance === "important" ? 0.5 : 0.2;
    const novelty = 0.6; // Observations are inherently somewhat novel

    const meta: ObservationSignalMeta = {
      source: "observation",
      observationId: obs.id,
      category: obs.category || "general",
    };

    return {
      id: generatePrefixedId("SIG"),
      source: "observation" as const,
      agentId,
      timestamp: obs.timestamp,
      summary: `Observation [${obs.category || "general"}]: ${obs.content.slice(0, 100)}`,
      urgency,
      stakes,
      novelty,
      metadata: meta,
    };
  });
}

// ── 3. Fact Change Scanner ────────────────────────────────────

export async function scanFactChanges(
  agentDir: string,
  agentId: string,
  previousVersion: number,
): Promise<CognitiveSignal[]> {
  const store = (await readJson(join(agentDir, "facts.json"))) as {
    facts?: Fact[];
    version?: number;
  } | null;
  if (!store?.facts || (store.version ?? 0) <= previousVersion) return [];

  const signals: CognitiveSignal[] = [];
  const now = new Date().toISOString();

  for (const fact of store.facts) {
    const factTime = new Date(fact.updated_at || fact.created_at).getTime();
    // Only scan facts updated since we last checked
    if (factTime <= new Date(now).getTime() - 30 * 60 * 1000) continue;

    // Detect low confidence (potential contradiction indicator)
    if (fact.confidence < 0.4) {
      const meta: FactChangeSignalMeta = {
        source: "fact_change",
        factId: fact.id,
        changeType: "confidence_drop",
        newConfidence: fact.confidence,
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "fact_change",
        agentId,
        timestamp: fact.updated_at,
        summary: `Fact ${fact.id}: low confidence (${fact.confidence}) — (${fact.subject}, ${fact.predicate}, ${fact.object})`,
        urgency: normalizeUrgency("fact_change", "confidence_drop"),
        stakes: 0.5,
        novelty: 0.4,
        metadata: meta,
      });
    }

    // Detect newly derived facts
    if (fact.source === "inference" && fact.derived_from && fact.derived_from.length > 0) {
      const meta: FactChangeSignalMeta = {
        source: "fact_change",
        factId: fact.id,
        changeType: "new",
        newConfidence: fact.confidence,
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "fact_change",
        agentId,
        timestamp: fact.created_at,
        summary: `New inferred fact ${fact.id}: (${fact.subject}, ${fact.predicate}, ${fact.object})`,
        urgency: normalizeUrgency("fact_change", "new"),
        stakes: 0.3,
        novelty: 0.7,
        metadata: meta,
      });
    }
  }

  return signals;
}

// ── 4. Goal State Scanner ─────────────────────────────────────

interface ParsedGoal {
  id: string;
  description: string;
  status: string;
  priority: number;
  deadline: string;
  progress: number;
  level: string;
  parentGoal?: string;
}

function parseGoalsMd(content: string): ParsedGoal[] {
  const goals: ParsedGoal[] = [];
  const goalBlocks = content.split(/\n### /).slice(1); // Skip header

  for (const block of goalBlocks) {
    const firstLine = block.split("\n")[0] || "";
    const idMatch = firstLine.match(/^(G-[\w-]+):\s*(.*)/);
    if (!idMatch) continue;

    const getField = (field: string): string => {
      const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
      const m = block.match(re);
      return m?.[1]?.trim() || "";
    };

    goals.push({
      id: idMatch[1],
      description: idMatch[2],
      status: getField("Status"),
      priority: parseFloat(getField("Priority")) || 0.5,
      deadline: getField("Deadline"),
      progress: parseFloat(getField("Progress")) || 0,
      level: getField("Level"),
      parentGoal: getField("Parent") || undefined,
    });
  }

  return goals;
}

export async function scanGoalState(agentDir: string, agentId: string): Promise<CognitiveSignal[]> {
  const content = await readMd(join(agentDir, "Goals.md"));
  if (!content) return [];

  const goals = parseGoalsMd(content);
  const signals: CognitiveSignal[] = [];
  const now = new Date();

  for (const goal of goals) {
    if (goal.status === "active" || goal.status === "in_progress") {
      // Check failing goals (high priority, low progress)
      if (goal.priority >= 0.7 && goal.progress < 20) {
        const meta: GoalStateSignalMeta = {
          source: "goal_state",
          goalId: goal.id,
          transition: "failing",
        };
        signals.push({
          id: generatePrefixedId("SIG"),
          source: "goal_state",
          agentId,
          timestamp: now.toISOString(),
          summary: `Goal ${goal.id} may be failing: priority=${goal.priority}, progress=${goal.progress}%`,
          urgency: normalizeUrgency("goal_state", "failing"),
          stakes: goal.priority,
          novelty: 0.3,
          metadata: meta,
        });
      }

      // Check deadline-approaching goals
      if (goal.deadline && goal.deadline !== "ongoing" && goal.deadline !== "—") {
        const deadlineDate = new Date(goal.deadline);
        const hoursRemaining = (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (hoursRemaining > 0 && hoursRemaining <= 72) {
          const urgencyLevel =
            hoursRemaining <= 3 ? "hours_3" : hoursRemaining <= 24 ? "hours_24" : "hours_72";
          const meta: GoalStateSignalMeta = {
            source: "goal_state",
            goalId: goal.id,
            transition: "deadline_approaching",
          };
          signals.push({
            id: generatePrefixedId("SIG"),
            source: "goal_state",
            agentId,
            timestamp: now.toISOString(),
            summary: `Goal ${goal.id} deadline in ${Math.round(hoursRemaining)}h: ${goal.description}`,
            urgency: normalizeUrgency("deadline", urgencyLevel),
            stakes: goal.priority,
            novelty: 0.2,
            metadata: meta,
          });
        } else if (hoursRemaining <= 0) {
          const meta: GoalStateSignalMeta = {
            source: "goal_state",
            goalId: goal.id,
            transition: "failing",
          };
          signals.push({
            id: generatePrefixedId("SIG"),
            source: "goal_state",
            agentId,
            timestamp: now.toISOString(),
            summary: `Goal ${goal.id} EXPIRED deadline: ${goal.description}`,
            urgency: 1.0,
            stakes: goal.priority,
            novelty: 0.3,
            metadata: meta,
          });
        }
      }
    }
  }

  return signals;
}

// ── 5. Rule Violation Scanner ─────────────────────────────────

export async function scanRuleViolations(
  agentDir: string,
  agentId: string,
): Promise<CognitiveSignal[]> {
  const factStore = (await readJson(join(agentDir, "facts.json"))) as {
    facts?: Fact[];
  } | null;
  const ruleStore = (await readJson(join(agentDir, "rules.json"))) as {
    rules?: Rule[];
  } | null;

  const facts = (factStore?.facts || []) as Fact[];
  const rules = (ruleStore?.rules || []) as Rule[];
  const constraints = rules.filter((r) => r.enabled && r.type === "constraint");

  const signals: CognitiveSignal[] = [];
  const now = new Date().toISOString();

  for (const rule of constraints) {
    const allMatch = rule.conditions.every((cond) =>
      facts.some((f) => matchConditionToFact(cond, f)),
    );

    if (allMatch) {
      const severity = rule.severity || "warning";
      const meta: RuleViolationSignalMeta = {
        source: "rule_violation",
        ruleId: rule.id,
        severity,
        violationMessage:
          rule.violation_message ||
          `Constraint ${rule.id} violated: ${rule.description || rule.name}`,
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "rule_violation",
        agentId,
        timestamp: now,
        summary: `Violation [${severity}]: ${meta.violationMessage}`,
        urgency: normalizeUrgency("rule_violation", severity),
        stakes: severity === "critical" ? 1.0 : severity === "error" ? 0.7 : 0.4,
        novelty: 0.3,
        metadata: meta,
      });
    }
  }

  return signals;
}

// ── 6. Policy Scanner ─────────────────────────────────────────

export async function scanPolicies(agentDir: string, agentId: string): Promise<CognitiveSignal[]> {
  const factStore = (await readJson(join(agentDir, "facts.json"))) as {
    facts?: Fact[];
  } | null;
  const ruleStore = (await readJson(join(agentDir, "rules.json"))) as {
    rules?: Rule[];
  } | null;

  const facts = (factStore?.facts || []) as Fact[];
  const rules = (ruleStore?.rules || []) as Rule[];
  const policies = rules.filter((r) => r.enabled && r.type === "policy");

  const signals: CognitiveSignal[] = [];
  const now = new Date().toISOString();

  for (const rule of policies) {
    const allMatch = rule.conditions.every((cond) =>
      facts.some((f) => matchConditionToFact(cond, f)),
    );

    if (allMatch) {
      const urgencyLevel = rule.escalate ? "escalate" : rule.action ? "action" : "notify";
      const meta: PolicyTriggerSignalMeta = {
        source: "policy_trigger",
        ruleId: rule.id,
        action: rule.action || "none",
        escalate: rule.escalate || false,
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "policy_trigger",
        agentId,
        timestamp: now,
        summary: `Policy ${rule.id} triggered: ${rule.name}${rule.escalate ? " [ESCALATE]" : ""}`,
        urgency: normalizeUrgency("policy_trigger", urgencyLevel),
        stakes: rule.escalate ? 0.8 : 0.5,
        novelty: 0.3,
        metadata: meta,
      });
    }
  }

  return signals;
}

// ── 7. Deadline Scanner ───────────────────────────────────────

interface ParsedIntention {
  id: string;
  deadline?: string;
  status: string;
}

function parseIntentionsMd(content: string): ParsedIntention[] {
  const intentions: ParsedIntention[] = [];
  const blocks = content.split(/\n### /).slice(1);

  for (const block of blocks) {
    const firstLine = block.split("\n")[0] || "";
    const idMatch = firstLine.match(/^(I-[\w-]+):/);
    if (!idMatch) continue;

    const getField = (field: string): string => {
      const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, "i");
      const m = block.match(re);
      return m?.[1]?.trim() || "";
    };

    intentions.push({
      id: idMatch[1],
      deadline: getField("Deadline") || undefined,
      status: getField("Status"),
    });
  }

  return intentions;
}

export async function scanDeadlines(
  agentDir: string,
  agentId: string,
  warningHours = 72,
): Promise<CognitiveSignal[]> {
  const goalsContent = await readMd(join(agentDir, "Goals.md"));
  const intentionsContent = await readMd(join(agentDir, "Intentions.md"));

  const signals: CognitiveSignal[] = [];
  const now = new Date();

  // Scan goal deadlines
  const goals = parseGoalsMd(goalsContent);
  for (const goal of goals) {
    if (goal.status !== "active" && goal.status !== "in_progress") continue;
    if (!goal.deadline || goal.deadline === "ongoing" || goal.deadline === "—") continue;

    const deadline = new Date(goal.deadline);
    const hoursRemaining = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursRemaining > 0 && hoursRemaining <= warningHours) {
      const urgencyLevel =
        hoursRemaining <= 3
          ? "hours_3"
          : hoursRemaining <= 24
            ? "hours_24"
            : hoursRemaining <= 72
              ? "hours_72"
              : "days_7";
      const meta: DeadlineSignalMeta = {
        source: "deadline",
        entityId: goal.id,
        entityType: "goal",
        deadline: goal.deadline,
        hoursRemaining: Math.round(hoursRemaining),
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "deadline",
        agentId,
        timestamp: now.toISOString(),
        summary: `Goal ${goal.id} deadline in ${Math.round(hoursRemaining)}h`,
        urgency: normalizeUrgency("deadline", urgencyLevel),
        stakes: goal.priority,
        novelty: 0.1,
        metadata: meta,
      });
    } else if (hoursRemaining <= 0) {
      const meta: DeadlineSignalMeta = {
        source: "deadline",
        entityId: goal.id,
        entityType: "goal",
        deadline: goal.deadline,
        hoursRemaining: 0,
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "deadline",
        agentId,
        timestamp: now.toISOString(),
        summary: `Goal ${goal.id} PAST DEADLINE`,
        urgency: normalizeUrgency("deadline", "expired"),
        stakes: goal.priority,
        novelty: 0.2,
        metadata: meta,
      });
    }
  }

  // Scan intention deadlines
  const intentions = parseIntentionsMd(intentionsContent);
  for (const intention of intentions) {
    if (intention.status !== "executing" && intention.status !== "active") continue;
    if (!intention.deadline) continue;

    const deadline = new Date(intention.deadline);
    const hoursRemaining = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursRemaining > 0 && hoursRemaining <= warningHours) {
      const urgencyLevel =
        hoursRemaining <= 3 ? "hours_3" : hoursRemaining <= 24 ? "hours_24" : "hours_72";
      const meta: DeadlineSignalMeta = {
        source: "deadline",
        entityId: intention.id,
        entityType: "intention",
        deadline: intention.deadline,
        hoursRemaining: Math.round(hoursRemaining),
      };
      signals.push({
        id: generatePrefixedId("SIG"),
        source: "deadline",
        agentId,
        timestamp: now.toISOString(),
        summary: `Intention ${intention.id} deadline in ${Math.round(hoursRemaining)}h`,
        urgency: normalizeUrgency("deadline", urgencyLevel),
        stakes: 0.6,
        novelty: 0.1,
        metadata: meta,
      });
    }
  }

  return signals;
}

// ── Aggregate Scanner ─────────────────────────────────────────

/**
 * Run all 7 scanners for an agent and return the combined signal set.
 */
export async function scanAllSignals(
  agentDir: string,
  agentId: string,
  lastHeartbeatAt: string,
  lastFactVersion = 0,
): Promise<CognitiveSignal[]> {
  const results = await Promise.all([
    scanInbox(agentDir, agentId, lastHeartbeatAt),
    scanObservations(agentDir, agentId, lastHeartbeatAt),
    scanFactChanges(agentDir, agentId, lastFactVersion),
    scanGoalState(agentDir, agentId),
    scanRuleViolations(agentDir, agentId),
    scanPolicies(agentDir, agentId),
    scanDeadlines(agentDir, agentId),
  ]);

  return results.flat();
}
