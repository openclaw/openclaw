/**
 * Cognitive Router — Dual-Process Orchestrator
 *
 * Wires reflexive (System 1), analytical (System 1.5), and deliberative
 * (System 2) processing into an automatic fast-then-slow pipeline.
 * Each agent autonomously manages its processing depth based on
 * situation demands and role thresholds.
 *
 * Three new tools:
 * - cognitive_demand — Diagnostic: assess demand score for an agent
 * - cognitive_route  — On-demand: trigger cognitive routing
 * - cognitive_status — Inspection: view router state
 *
 * Enhanced heartbeat replaces the flat maintenance loop.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import type {
  ProcessingDepth,
  CognitiveSignal,
  CognitiveDemand,
  RoleThresholds,
  CognitiveRouterState,
  AgentRouterState,
  ProcessingResult,
  CognitiveRouterConfig,
  ReflexiveAction,
} from "./cognitive-router-types.js";
import { DEFAULT_ROLE_THRESHOLDS, DEFAULT_SUBAGENT_THRESHOLDS } from "./cognitive-router-types.js";
import { scanAllSignals } from "./cognitive-signal-scanners.js";
import { textResult, resolveWorkspaceDir, generatePrefixedId } from "./common.js";
import { runReflexiveProcessing } from "./reflexive-processor.js";
import { ROLE_TOOL_SCOPE, isToolAllowedForRole } from "./tool-filter.js";

// ── File I/O ──────────────────────────────────────────────────

async function readJson(p: string): Promise<any> {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(p: string, d: any): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

async function readMd(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function writeMd(p: string, c: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, c, "utf-8");
}

// ── LLM Caller ─────────────────────────────────────────────────

// Providers that returned 401/403 are blocked for the lifetime of this process
// to avoid wasting ~200ms per call on known-bad credentials.
const _blockedProviders = new Set<string>();

async function callLlm(
  api: OpenClawPluginApi,
  systemPrompt: string,
  userPrompt: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string | null> {
  if (!api?.runtime?.modelAuth) return null;

  // Provider list: try each in order, skip blocked ones
  // Primary: OpenAI gpt-5.4, Fallback: Anthropic claude-sonnet-4
  const providers: Array<{
    name: string;
    call: (apiKey: string) => Promise<string | null>;
  }> = [
    {
      name: "openai",
      call: async (apiKey) => {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            max_completion_tokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.3,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return data.choices?.[0]?.message?.content ?? null;
        }
        const errBody = await resp.text().catch(() => "");
        console.log(`[callLlm] OpenAI error (${resp.status}): ${errBody.slice(0, 200)}`);
        if (resp.status === 401 || resp.status === 403) {
          _blockedProviders.add("openai");
        }
        return null;
      },
    },
    {
      name: "anthropic",
      call: async (apiKey) => {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.3,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
          }),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { content?: Array<{ text?: string }> };
          return data.content?.[0]?.text ?? null;
        }
        const errBody = await resp.text().catch(() => "");
        console.log(`[callLlm] Anthropic error (${resp.status}): ${errBody.slice(0, 200)}`);
        if (resp.status === 401 || resp.status === 403) {
          _blockedProviders.add("anthropic");
        }
        return null;
      },
    },
  ];

  for (const provider of providers) {
    if (_blockedProviders.has(provider.name)) continue;
    try {
      const auth = await api.runtime.modelAuth.resolveApiKeyForProvider({
        provider: provider.name,
        cfg: api.config,
      });
      if (!auth?.apiKey) continue;
      const result = await provider.call(auth.apiKey);
      if (result) return result;
    } catch {
      // Provider failed — try next
    }
  }

  return null;
}

// ── Demand Scoring ────────────────────────────────────────────

const DEFAULT_SIGNAL_WEIGHTS = {
  urgency: 0.3,
  stakes: 0.3,
  novelty: 0.15,
  volume: 0.1,
  recency: 0.15,
};

/**
 * Compute aggregated cognitive demand from signals.
 * Peak-driven: a single critical signal forces high demand.
 */
export function computeCognitiveDemand(
  signals: CognitiveSignal[],
  _thresholds: RoleThresholds,
  lastFullCycleAt: string,
  weights = DEFAULT_SIGNAL_WEIGHTS,
): CognitiveDemand {
  if (signals.length === 0) {
    return {
      score: 0,
      breakdown: { urgency: 0, stakes: 0, novelty: 0, volume: 0, recency: 0 },
      signalCount: 0,
      peakSignal: null,
    };
  }

  // Peak values (single highest signal drives depth, not average)
  const peakUrgency = Math.max(...signals.map((s) => s.urgency));
  const peakStakes = Math.max(...signals.map((s) => s.stakes));
  const peakNovelty = Math.max(...signals.map((s) => s.novelty));

  // Volume: log-scaled signal count (diminishing returns)
  const volumeScore = Math.min(1, Math.log2(signals.length + 1) / 5);

  // Recency: time since last full cycle (0 = just ran, 1 = overdue)
  const lastFull = new Date(lastFullCycleAt).getTime();
  const now = Date.now();
  const minutesSinceFullCycle = (now - lastFull) / (1000 * 60);
  // Normalize to 0-1: 0 at cycle time, 1 at 4x the expected interval
  const recencyScore = Math.min(1, minutesSinceFullCycle / (240 * 4));

  // Weighted aggregate
  const urgencyComponent = peakUrgency * weights.urgency;
  const stakesComponent = peakStakes * weights.stakes;
  const noveltyComponent = peakNovelty * weights.novelty;
  const volumeComponent = volumeScore * weights.volume;
  const recencyComponent = recencyScore * weights.recency;

  const score = Math.min(
    1,
    urgencyComponent + stakesComponent + noveltyComponent + volumeComponent + recencyComponent,
  );

  // Find the peak signal (highest combined urgency + stakes)
  let peakSignal = signals[0];
  let peakScore = 0;
  for (const s of signals) {
    const combined = s.urgency * 0.6 + s.stakes * 0.4;
    if (combined > peakScore) {
      peakScore = combined;
      peakSignal = s;
    }
  }

  return {
    score,
    breakdown: {
      urgency: urgencyComponent,
      stakes: stakesComponent,
      novelty: noveltyComponent,
      volume: volumeComponent,
      recency: recencyComponent,
    },
    signalCount: signals.length,
    peakSignal,
  };
}

// ── Depth Selection ───────────────────────────────────────────

/**
 * Select processing depth based on demand score and role thresholds.
 */
export function selectDepth(score: number, thresholds: RoleThresholds): ProcessingDepth {
  if (score <= thresholds.reflexiveCeiling) return "reflexive";
  if (score >= thresholds.deliberativeFloor) return "deliberative";
  return "analytical";
}

/**
 * Apply override rules that force minimum depth regardless of score.
 */
export function applyDepthOverrides(
  depth: ProcessingDepth,
  signals: CognitiveSignal[],
  consecutiveReflexive: number,
  thresholds: RoleThresholds,
): ProcessingDepth {
  const depthOrder: ProcessingDepth[] = ["reflexive", "analytical", "deliberative"];
  let minDepthIdx = depthOrder.indexOf(depth);

  // Policy escalation flag → at least analytical
  const hasEscalatingPolicy = signals.some(
    (s) => s.source === "policy_trigger" && (s.metadata as any).escalate,
  );
  if (hasEscalatingPolicy && minDepthIdx < 1) minDepthIdx = 1;

  // Supervisor explicit request → use requested depth
  const supervisorSignal = signals.find((s) => s.source === "supervisor");
  if (supervisorSignal) {
    const requested = (supervisorSignal.metadata as any).requestedDepth;
    if (requested) {
      const reqIdx = depthOrder.indexOf(requested);
      if (reqIdx >= 0) minDepthIdx = Math.max(minDepthIdx, reqIdx);
    }
  }

  // Too many consecutive reflexive cycles → force analytical
  if (depth === "reflexive" && consecutiveReflexive >= thresholds.maxConsecutiveReflexive) {
    minDepthIdx = Math.max(minDepthIdx, 1);
  }

  // Critical rule violation → force deliberative
  const hasCriticalViolation = signals.some(
    (s) => s.source === "rule_violation" && (s.metadata as any).severity === "critical",
  );
  if (hasCriticalViolation) minDepthIdx = 2;

  // Strategic goal failing → at least analytical
  const hasFailingGoal = signals.some(
    (s) =>
      s.source === "goal_state" &&
      ((s.metadata as any).transition === "failing" ||
        (s.metadata as any).transition === "blocked") &&
      s.stakes >= 0.7,
  );
  if (hasFailingGoal && minDepthIdx < 1) minDepthIdx = 1;

  // Inbox REQUEST/QUERY/CFP → at least analytical (agents must compose a response)
  const hasActionableInbox = signals.some((s) => {
    if (s.source !== "inbox") return false;
    const perf = ((s.metadata as any).performative || "").toUpperCase();
    return perf === "REQUEST" || perf === "QUERY" || perf === "CFP" || perf === "DIRECTIVE";
  });
  if (hasActionableInbox && minDepthIdx < 1) minDepthIdx = 1;

  return depthOrder[minDepthIdx];
}

// ── Processing Executors ──────────────────────────────────────

/**
 * Execute reflexive processing (zero LLM calls).
 */
async function executeReflexive(
  agentId: string,
  agentDir: string,
  role: string,
  signals: CognitiveSignal[],
  thresholds: RoleThresholds,
): Promise<ProcessingResult> {
  const outcome = await runReflexiveProcessing({
    agentId,
    agentDir,
    role,
    signals,
    thresholds,
  });

  const trace = [
    `Reflexive processing for ${agentId} (${role})`,
    `Inbox processed: ${outcome.stats.inboxProcessed}`,
    `Facts inferred: ${outcome.stats.factsInferred}`,
    `Constraint violations: ${outcome.stats.constraintViolations}`,
    `Policies triggered: ${outcome.stats.policiesTriggered}`,
    `Goals checked: ${outcome.stats.goalsChecked}`,
    `Threshold alerts: ${outcome.stats.thresholdAlerts}`,
    `Actions: ${outcome.actions.length}, Escalations: ${outcome.escalations.length}`,
  ];

  const conclusion =
    outcome.escalations.length > 0
      ? `Reflexive processing found ${outcome.escalations.length} escalation(s): ${outcome.escalations.map((e) => e.reason).join("; ")}`
      : `Reflexive processing complete: ${outcome.actions.length} action(s), no escalations needed.`;

  return {
    depth: "reflexive",
    confidence: outcome.confidence,
    conclusion,
    reasoningTrace: trace,
    methodsUsed: ["pattern-matching", "forward-chaining", "constraint-check", "policy-eval"],
    tokensConsumed: 0,
    escalated: false,
    escalationHistory: [],
    _reflexiveActions: outcome.actions,
  };
}

/**
 * Execute analytical processing (1 LLM call via meta-reasoning).
 */
async function executeAnalytical(
  agentId: string,
  agentDir: string,
  signals: CognitiveSignal[],
  api: OpenClawPluginApi,
): Promise<ProcessingResult> {
  // Derive problem classification heuristically from signals
  const peakUrgency = Math.max(...signals.map((s) => s.urgency), 0);
  const peakStakes = Math.max(...signals.map((s) => s.stakes), 0);
  const peakNovelty = Math.max(...signals.map((s) => s.novelty), 0);

  const uncertainty = peakNovelty > 0.6 ? "high" : peakNovelty > 0.3 ? "medium" : "low";
  const complexity = signals.length > 5 ? "complex" : signals.length > 2 ? "moderate" : "simple";
  const time_pressure = peakUrgency > 0.7 ? "urgent" : peakUrgency > 0.4 ? "moderate" : "none";
  const stakes = peakStakes > 0.7 ? "high" : peakStakes > 0.3 ? "medium" : "low";

  const classification = {
    uncertainty: uncertainty as "low" | "medium" | "high",
    complexity: complexity as "simple" | "moderate" | "complex",
    domain: "mixed" as const,
    time_pressure: time_pressure as "none" | "moderate" | "urgent",
    data_availability: "moderate" as const,
    stakes: stakes as "low" | "medium" | "high",
  };

  // Score methods using the selection matrix
  let topMethod = "heuristic";
  let methodScore = 0.5;
  try {
    const { scoreMethodsForProblem } = await import("../reasoning/meta/meta-reasoning.js");
    const agentConfig = await readJson(join(agentDir, "agent.json"));
    const available = agentConfig?.bdi?.reasoningMethods;
    const recommendations = scoreMethodsForProblem(classification, available);
    if (recommendations.length > 0) {
      topMethod = recommendations[0].method;
      methodScore = recommendations[0].score;
    }
  } catch {
    // Meta-reasoning unavailable — use default
  }

  // Build problem summary from signals
  const problemSummary = signals
    .slice(0, 5)
    .map((s) => s.summary)
    .join("\n");

  const trace = [
    `Analytical processing for ${agentId}`,
    `Problem classification: ${JSON.stringify(classification)}`,
    `Top method: ${topMethod} (score: ${methodScore.toFixed(2)})`,
    `Signals summarized: ${signals.length}`,
  ];

  // Resolve role from agent config for tool scope
  const agentCfg = await readJson(join(agentDir, "agent.json"));
  const role = agentCfg?.id || agentId;
  const toolScope = ROLE_TOOL_SCOPE[role]?.join(", ") || "all BDI tools";

  const systemPrompt = `You are the ${agentId} agent. Analyze the following signals and produce a structured assessment.
Your authorized tools for this role: ${toolScope}
Only recommend actions using tools within your domain. For cross-domain needs, send a message to the appropriate C-suite agent.

You MUST respond in this EXACT format with ALL sections present. Do NOT use markdown formatting (no ** or ##). Each section MUST be on its own line followed by a newline, then bullet items starting with "- ":

CONFIDENCE: [0.0-1.0]
ASSESSMENT: [1-3 sentence analysis]
BELIEF_UPDATES:
- [a new fact or belief you can infer from these signals, e.g. "Cash flow is critically low due to $2M withdrawal"]
GOAL_UPDATES:
- [G-ID: progress% reason — use exact goal IDs from context, estimate progress based on actions taken]
NEW_INTENTIONS:
- [specific next action to take, or "none"]
ACTIONS:
- [concrete tool call or task to execute, or "none"]

IMPORTANT: For BELIEF_UPDATES, always extract at least one factual observation from the signals. For GOAL_UPDATES, reference the exact G-ID from the active goals and estimate progress percentage. Do not say "none" unless truly nothing applies.`;

  // Load active goal IDs so the LLM can reference them
  let goalContext = "";
  try {
    const goalsRaw = await readMd(join(agentDir, "Goals.md"));
    const goalLines = goalsRaw
      .split("\n")
      .filter((l) => l.startsWith("### G-"))
      .map((l) => l.replace("### ", "").slice(0, 100))
      .slice(0, 5);
    if (goalLines.length > 0) {
      goalContext = `\n\nActive Goals:\n${goalLines.map((g) => `- ${g}`).join("\n")}`;
    }
  } catch {
    /* no goals */
  }

  const userPrompt = `Classification: uncertainty=${classification.uncertainty}, complexity=${classification.complexity}, stakes=${classification.stakes}, time_pressure=${classification.time_pressure}
Selected method: ${topMethod} (${(methodScore * 100).toFixed(0)}% suitability)

Signals (${signals.length}):
${problemSummary}${goalContext}

Apply ${topMethod} reasoning. Determine actions and whether deliberative depth is needed.`;

  // Invoke LLM
  const llmText = await callLlm(api, systemPrompt, userPrompt, {
    maxTokens: 1024,
    temperature: 0.3,
  });

  let conclusion: string;
  let confidence = methodScore * 0.8;

  if (llmText) {
    conclusion = llmText;
    // Parse confidence from response
    const confMatch = llmText.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confMatch) {
      const parsed = parseFloat(confMatch[1]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) confidence = parsed;
    }
    trace.push("LLM invoked: Anthropic/OpenAI");
  } else {
    // Fallback: structured prompt-based output (no LLM available)
    conclusion = `## Analytical Assessment — ${agentId}

**Classification:** uncertainty=${classification.uncertainty}, complexity=${classification.complexity}, stakes=${classification.stakes}, time_pressure=${classification.time_pressure}

**Selected Method:** ${topMethod} (${(methodScore * 100).toFixed(0)}% suitability)

**Signals (${signals.length}):**
${problemSummary}

**Instruction:** Apply ${topMethod} reasoning to the above signals. Determine actions and whether deliberative depth is needed.`;
    trace.push("LLM unavailable: using structured fallback");
  }

  return {
    depth: "analytical",
    confidence,
    conclusion,
    reasoningTrace: trace,
    methodsUsed: [topMethod],
    tokensConsumed: llmText ? 1 : 0,
    escalated: false,
    escalationHistory: [],
  };
}

/**
 * Execute deliberative processing (full BDI cycle, 1 LLM call with truncated context).
 */
async function executeDeliberative(
  agentId: string,
  agentDir: string,
  signals: CognitiveSignal[],
  api: OpenClawPluginApi,
): Promise<ProcessingResult> {
  // Load cognitive files with truncation to control token costs
  const truncate = (s: string, maxChars: number) =>
    s.length > maxChars ? s.slice(0, maxChars) + "\n...(truncated)" : s;

  // Extract only active/executing blocks from structured files
  const extractActiveBlocks = (content: string, statusPattern: RegExp): string => {
    if (!content) return "None.";
    const blocks = content.split(/\n### /).slice(1);
    const active = blocks.filter((b) => statusPattern.test(b));
    return active.length > 0
      ? active
          .map((b) => "### " + b)
          .join("\n")
          .slice(0, 1500)
      : "None active.";
  };

  const goalsRaw = await readMd(join(agentDir, "Goals.md"));
  const intentionsRaw = await readMd(join(agentDir, "Intentions.md"));
  const plansRaw = await readMd(join(agentDir, "Plans.md"));
  const memoryRaw = await readMd(join(agentDir, "Memory.md"));
  const beliefsRaw = await readMd(join(agentDir, "Beliefs.md"));
  const personaRaw = await readMd(join(agentDir, "Persona.md"));

  const activeGoals = extractActiveBlocks(goalsRaw, /\*\*Status:\*\*\s*active/i);
  const executingIntentions = extractActiveBlocks(intentionsRaw, /\*\*Status:\*\*\s*executing/i);
  const activePlans = extractActiveBlocks(plansRaw, /\*\*Status:\*\*\s*active/i);
  const recentMemory = memoryRaw ? memoryRaw.split("\n").slice(-20).join("\n") : "None.";

  // Get top 3 methods via meta-reasoning
  let top3Methods: string[] = ["means-ends", "causal", "decision-theory"];
  try {
    const { scoreMethodsForProblem } = await import("../reasoning/meta/meta-reasoning.js");
    const agentConfig = await readJson(join(agentDir, "agent.json"));
    const available = agentConfig?.bdi?.reasoningMethods;

    const peakStakes = Math.max(...signals.map((s) => s.stakes), 0);
    const peakNovelty = Math.max(...signals.map((s) => s.novelty), 0);
    const recommendations = scoreMethodsForProblem(
      {
        uncertainty: peakNovelty > 0.5 ? "high" : "medium",
        complexity: "complex",
        domain: "mixed",
        time_pressure: "none",
        data_availability: "moderate",
        stakes: peakStakes > 0.7 ? "high" : "medium",
      },
      available,
    );
    top3Methods = recommendations.slice(0, 3).map((r) => r.method);
  } catch {
    // Use defaults
  }

  const signalSummary = signals
    .slice(0, 10)
    .map(
      (s) =>
        `- [${s.source}] ${s.summary} (urgency=${s.urgency.toFixed(2)}, stakes=${s.stakes.toFixed(2)})`,
    )
    .join("\n");

  const trace = [
    `Deliberative processing for ${agentId}`,
    `Truncated BDI context (active blocks only)`,
    `Multi-method fusion: ${top3Methods.join(", ")}`,
    `Signals: ${signals.length}`,
  ];

  // Resolve role for tool scope
  const agentCfg = await readJson(join(agentDir, "agent.json"));
  const role = agentCfg?.id || agentId;
  const toolScope = ROLE_TOOL_SCOPE[role]?.join(", ") || "all BDI tools";

  const systemPrompt = `You are the ${agentId} agent performing full BDI deliberation.
Your authorized tools: ${toolScope}
Only recommend actions within your domain. For cross-domain needs, use agent_message.

You MUST respond in this EXACT format with ALL sections. Do NOT use markdown formatting (no ** or ##). Each section header MUST be on its own line followed by a newline, then bullet items starting with "- ":

CONFIDENCE: [0.0-1.0]
ASSESSMENT: [2-5 sentence analysis]
BELIEF_UPDATES:
- [extract factual observations from signals and context, e.g. "Revenue is declining at 15% month-over-month"]
- [at least one belief per deliberation cycle]
GOAL_UPDATES:
- [use EXACT goal IDs from Active Goals below, e.g. "G-CFO-001: 10% Initial analysis and planning phase complete"]
ACTIONS:
- [concrete next step, or "none"]
NEW_INTENTIONS:
- [specific commitment to act on, or "none"]

IMPORTANT: Always include at least one BELIEF_UPDATE based on signal analysis. For GOAL_UPDATES, use the exact G-ID from the Active Goals section and estimate realistic progress. Even early-stage work (analysis, planning) counts as 5-15% progress.`;

  const userPrompt = `## Triggering Signals (${signals.length})
${signalSummary}

## Persona
${truncate(personaRaw, 500)}

## Active Goals
${activeGoals}

## Executing Intentions
${executingIntentions}

## Active Plans
${activePlans}

## Beliefs (summary)
${truncate(beliefsRaw, 500)}

## Recent Memory
${recentMemory}

## Methods
Apply these in order: ${top3Methods.join(", ")}
Determine: actions, goal updates, new intentions, belief revisions.
Before executing high-stakes actions (financial >$1000, legal, public-facing), verify approval requirements.

REMEMBER: Use the exact G-ID from Active Goals above for GOAL_UPDATES. Extract beliefs from the signals and context.`;

  // Invoke LLM
  const llmText = await callLlm(api, systemPrompt, userPrompt, {
    maxTokens: 1024,
    temperature: 0.2,
  });

  let conclusion: string;
  let confidence = 0.6;

  if (llmText) {
    conclusion = llmText;
    const confMatch = llmText.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confMatch) {
      const parsed = parseFloat(confMatch[1]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) confidence = parsed;
    }
    trace.push("LLM invoked: Anthropic/OpenAI (deliberative)");
  } else {
    // Fallback: raw prompt as conclusion
    conclusion = `## Full BDI Cycle — ${agentId}

### Triggering Signals (${signals.length})
${signalSummary}

### Active Goals
${activeGoals}

### Executing Intentions
${executingIntentions}

### Active Plans
${activePlans}

### Multi-Method Fusion
Apply these methods in order: ${top3Methods.join(", ")}
Fuse results and determine: actions, goal updates, new intentions, belief revisions.`;
    trace.push("LLM unavailable: using structured fallback");
  }

  return {
    depth: "deliberative",
    confidence,
    conclusion,
    reasoningTrace: trace,
    methodsUsed: top3Methods,
    tokensConsumed: llmText ? 4 : 0,
    escalated: false,
    escalationHistory: [],
  };
}

// ── Escalation Cascade ────────────────────────────────────────

/**
 * Process with confidence-based escalation: reflexive → analytical → deliberative.
 * Auto-escalates when confidence is insufficient for the stakes level.
 */
export async function processWithEscalation(
  agentId: string,
  agentDir: string,
  role: string,
  depth: ProcessingDepth,
  signals: CognitiveSignal[],
  thresholds: RoleThresholds,
  api: OpenClawPluginApi,
): Promise<ProcessingResult> {
  const depthOrder: ProcessingDepth[] = ["reflexive", "analytical", "deliberative"];
  let currentDepthIdx = depthOrder.indexOf(depth);
  const escalationHistory: ProcessingDepth[] = [];
  let result: ProcessingResult | null = null;

  const peakStakes = Math.max(...signals.map((s) => s.stakes), 0);

  while (currentDepthIdx < depthOrder.length) {
    const currentDepth = depthOrder[currentDepthIdx];

    switch (currentDepth) {
      case "reflexive":
        result = await executeReflexive(agentId, agentDir, role, signals, thresholds);
        break;
      case "analytical":
        result = await executeAnalytical(agentId, agentDir, signals, api);
        break;
      case "deliberative":
        result = await executeDeliberative(agentId, agentDir, signals, api);
        break;
    }

    // Compute required confidence based on stakes
    // Higher stakes → higher confidence required to avoid escalation
    const requiredConfidence = 0.3 + (thresholds.analyticalConfidenceMin - 0.3) * peakStakes;

    if (result.confidence >= requiredConfidence || currentDepthIdx >= 2) {
      // Sufficient confidence or already at max depth
      break;
    }

    // Escalate to next depth
    escalationHistory.push(currentDepth);
    currentDepthIdx++;
  }

  if (result) {
    result.escalated = escalationHistory.length > 0;
    result.escalationHistory = escalationHistory;
  }

  return result!;
}

// ── Inbox Response Pipeline ──────────────────────────────────

/**
 * After cognitive processing, compose replies for actionable inbox messages
 * (REQUEST, QUERY, CFP) and mark all processed messages as read.
 * Writes responses to the sender's inbox using the same flat-array format.
 */
async function processInboxResponses(
  agentId: string,
  agentDir: string,
  workspaceDir: string,
  signals: CognitiveSignal[],
  result: ProcessingResult,
  log: { debug: (...args: any[]) => void; warn?: (...args: any[]) => void },
  api?: OpenClawPluginApi,
): Promise<void> {
  const inboxSignals = signals.filter((s) => s.source === "inbox");
  if (inboxSignals.length === 0) return;

  const inboxPath = join(agentDir, "inbox.json");
  const raw = await readJson(inboxPath);
  const messages: any[] = Array.isArray(raw) ? raw : raw?.messages || [];
  if (messages.length === 0) return;

  // Collect message IDs from inbox signals
  const signalMessageIds = new Set(
    inboxSignals.map((s) => (s.metadata as any).messageId as string),
  );

  const now = new Date().toISOString();
  let modified = false;
  let repliesSent = 0;

  for (const msg of messages) {
    if (!msg.id || msg.read || !signalMessageIds.has(msg.id)) continue;

    // Mark the message as read
    msg.read = true;
    msg.read_at = now;
    modified = true;

    const perf = (msg.performative || "").toUpperCase();

    // For REQUEST, QUERY, CFP, DIRECTIVE: compose and send a response
    if (perf === "REQUEST" || perf === "QUERY" || perf === "CFP" || perf === "DIRECTIVE") {
      const responsePerf = perf === "QUERY" ? "INFORM" : "CONFIRM";
      const msgPreview = (msg.content || msg.subject || "your message").slice(0, 300);

      // Build response content from processing result
      let responseContent: string;
      if (result.depth === "reflexive") {
        // Read agent's active goals to provide contextual acknowledgment
        let goalContext = "";
        try {
          const goalsMd = await readMd(join(agentDir, "Goals.md"));
          const activeGoals = goalsMd
            .split(/\n### /)
            .slice(1)
            .filter((b) => /\*\*Status:\*\*\s*active/i.test(b))
            .slice(0, 3)
            .map((b) => {
              const title = b.split("\n")[0]?.replace(/^G-\d+:\s*/, "") || "";
              return `  - ${title.slice(0, 80)}`;
            });
          if (activeGoals.length > 0) {
            goalContext = `\nRelevant active goals:\n${activeGoals.join("\n")}`;
          }
        } catch {
          // Goals unavailable
        }
        responseContent = [
          `Acknowledged your ${perf}: ${msgPreview}`,
          ``,
          `Processing: ${result.depth} | Confidence: ${result.confidence.toFixed(2)}`,
          `This has been queued for processing in the next analytical/deliberative cycle.${goalContext}`,
        ].join("\n");
      } else if (api) {
        // Analytical/Deliberative: per-message LLM call for tailored response
        const replyPrompt = `You are ${agentId}. Compose a concise, actionable reply to this message.

FROM: ${msg.from}
PERFORMATIVE: ${perf}
MESSAGE: ${msg.content || msg.subject || "(empty)"}

Your analysis context:
${result.conclusion.slice(0, 1500)}

Reply directly. State what you will do, concerns, and next steps.`;

        const reply = await callLlm(
          api,
          `You are the ${agentId} agent. Write a professional inter-agent response.`,
          replyPrompt,
          { maxTokens: 512 },
        );
        if (reply) {
          responseContent = reply;
        } else {
          // Fallback: structured response without LLM
          responseContent = [
            `Re: ${msgPreview.slice(0, 120)}`,
            ``,
            `Processing: ${result.depth} | Confidence: ${result.confidence.toFixed(2)}`,
            `Methods: ${result.methodsUsed.join(", ")}`,
            ``,
            result.conclusion.slice(0, 500),
          ].join("\n");
        }
      } else {
        // No API available — structured fallback
        responseContent = [
          `Re: ${msgPreview.slice(0, 120)}`,
          ``,
          `Processing: ${result.depth} | Confidence: ${result.confidence.toFixed(2)}`,
          `Methods: ${result.methodsUsed.join(", ")}`,
          ``,
          result.conclusion.slice(0, 500),
        ].join("\n");
      }

      // Write response to sender's inbox
      try {
        const senderInboxPath = join(workspaceDir, "agents", msg.from, "inbox.json");
        const senderRaw = await readJson(senderInboxPath);
        const senderInbox: any[] = Array.isArray(senderRaw) ? senderRaw : senderRaw?.messages || [];

        senderInbox.push({
          id: `REPLY-${msg.id}-${Date.now().toString(36)}`,
          from: agentId,
          to: msg.from,
          performative: responsePerf,
          content: responseContent,
          reply_to: msg.id,
          priority: msg.priority || "normal",
          timestamp: now,
          read: false,
        });

        await writeJson(senderInboxPath, senderInbox);
        repliesSent++;
      } catch (err) {
        log.warn?.(
          `[cognitive-router] Failed to send reply from ${agentId} to ${msg.from}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // For INFORM, ACCEPT, REJECT, CONFIRM, CANCEL: just mark read, no response needed
  }

  // Save updated inbox with read marks
  if (modified) {
    await writeJson(inboxPath, messages);
    log.debug(
      `[cognitive-router] ${agentId}: marked ${signalMessageIds.size} message(s) read, sent ${repliesSent} reply(s)`,
    );
  }
}

// ── Action Executors ──────────────────────────────────────────

/**
 * Execute reflexive actions (assert facts, log actions, send messages).
 * Called after reflexive processing to apply the generated actions.
 */
async function executeReflexiveActions(
  agentId: string,
  agentDir: string,
  workspaceDir: string,
  actions: ReflexiveAction[],
  log: { debug: (...args: any[]) => void },
): Promise<number> {
  let applied = 0;

  for (const action of actions) {
    try {
      switch (action.type) {
        case "assert_fact": {
          const factsPath = join(agentDir, "facts.json");
          const store = (await readJson(factsPath)) || { facts: [], version: 0 };
          const facts = store.facts || [];
          const d = action.data as Record<string, unknown>;
          // Skip if missing structured data (e.g. inbox_inform type assertions)
          if (!d.subject || !d.predicate || !d.object) break;
          // Deduplicate by subject+predicate+object
          const exists = facts.some(
            (f: any) =>
              f.subject === d.subject && f.predicate === d.predicate && f.object === d.object,
          );
          if (!exists) {
            facts.push({
              id: (d.id as string) || generatePrefixedId("FACT"),
              subject: d.subject,
              predicate: d.predicate,
              object: d.object,
              confidence: (d.confidence as number) ?? 0.5,
              source: d.ruleId ? `inference:${d.ruleId}` : "reflexive",
              derived_from: (d.derivedFrom as string[]) || [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            store.version++;
            await writeJson(factsPath, store);
            applied++;
          }
          break;
        }
        case "log_action": {
          const actionsPath = join(agentDir, "Actions.md");
          let content = await readMd(actionsPath);
          if (!content) {
            content = `# Actions — ${agentId}\n\n## Recent Actions\n`;
          }
          content += `\n- [${new Date().toISOString().split("T")[0]}] ${action.description}`;
          await writeMd(actionsPath, content);
          applied++;
          break;
        }
        case "send_message": {
          const d = action.data as Record<string, unknown>;
          if (d.to && d.content) {
            const recipientInboxPath = join(workspaceDir, "agents", d.to as string, "inbox.json");
            const raw = await readJson(recipientInboxPath);
            const inbox: any[] = Array.isArray(raw) ? raw : raw?.messages || [];
            inbox.push({
              id: generatePrefixedId("MSG"),
              from: agentId,
              to: d.to,
              performative: (d.performative as string) || "INFORM",
              content: d.content,
              priority: (d.priority as string) || "normal",
              timestamp: new Date().toISOString(),
              read: false,
            });
            await writeJson(recipientInboxPath, inbox);
            applied++;
          }
          break;
        }
      }
    } catch (err) {
      log.debug(`[action-executor] Failed to apply ${action.type}: ${err}`);
    }
  }
  return applied;
}

// ── LLM Action Parser & Executor ─────────────────────────────

interface LlmAction {
  type: "belief_update" | "goal_progress" | "new_intention";
  data: Record<string, unknown>;
}

/**
 * Extract a named section from structured LLM output.
 * Handles variations: `BELIEF_UPDATES:`, `Belief Updates:`, `**BELIEF_UPDATES:**`, `## Belief Updates`
 */
function extractSection(text: string, sectionName: string): string | null {
  // Build flexible patterns for the section header
  const words = sectionName.split("_");
  const camelCase = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  const upper = sectionName.toUpperCase();
  // Match: `SECTION_NAME:`, `Section Name:`, `**SECTION_NAME:**`, `## Section Name`
  const headerPattern = new RegExp(
    `(?:#{1,3}\\s*)?(?:\\*\\*)?(?:${upper}|${camelCase})(?:\\*\\*)?:\\s*\\n`,
    "i",
  );
  const match = text.match(headerPattern);
  if (!match) return null;

  const start = match.index! + match[0].length;
  // Capture until next section header (UPPERCASE_WORD: or ## Heading) or end
  const rest = text.slice(start);
  const nextHeader = rest.match(/\n(?:#{1,3}\s+)?(?:\*\*)?[A-Z][A-Z_\s]+(?:\*\*)?:\s*\n/);
  return nextHeader ? rest.slice(0, nextHeader.index!) : rest;
}

/** Extract list items from a section body. Handles `-`, `*`, and `1.` style lists. */
function extractListItems(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s|^\d+[.)]\s/.test(l))
    .map((l) => l.replace(/^[-*]\s*|^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

/** Check if a value is a "none" placeholder. */
function isNone(s: string): boolean {
  return /^(none|n\/a|no\s+updates?|no\s+changes?|no\s+new\s+|—|-|"none")$/i.test(s.trim());
}

function parseLlmActions(llmResponse: string): LlmAction[] {
  const actions: LlmAction[] = [];

  // Parse BELIEF_UPDATES section
  const beliefBody = extractSection(llmResponse, "BELIEF_UPDATES");
  if (beliefBody) {
    for (const item of extractListItems(beliefBody)) {
      if (!isNone(item)) {
        actions.push({ type: "belief_update", data: { content: item } });
      }
    }
  }

  // Parse GOAL_UPDATES section
  const goalBody = extractSection(llmResponse, "GOAL_UPDATES");
  if (goalBody) {
    for (const item of extractListItems(goalBody)) {
      if (isNone(item)) continue;
      // Flexible goal progress matching:
      // "G-CFO-001: 20% reason", "G-CFO-001 → 20%", "20% on G-CFO-001", "G-CFO-001 (20%)"
      const goalIdMatch = item.match(/(G-[\w-]+)/);
      const progressMatch = item.match(/(\d+)\s*%/);
      if (goalIdMatch && progressMatch) {
        const reason = item
          .replace(goalIdMatch[0], "")
          .replace(progressMatch[0], "")
          .replace(/[→:()]/g, "")
          .trim();
        actions.push({
          type: "goal_progress",
          data: {
            goalId: goalIdMatch[1],
            progress: parseInt(progressMatch[1]),
            reason: reason || "LLM assessment",
          },
        });
      }
    }
  }

  // Parse NEW_INTENTIONS section
  const intentionBody = extractSection(llmResponse, "NEW_INTENTIONS");
  if (intentionBody) {
    for (const item of extractListItems(intentionBody)) {
      if (!isNone(item)) {
        actions.push({ type: "new_intention", data: { content: item } });
      }
    }
  }

  // Parse ACTIONS section (log for observability)
  const actionsBody = extractSection(llmResponse, "ACTIONS");
  if (actionsBody) {
    for (const item of extractListItems(actionsBody)) {
      if (!isNone(item)) {
        // Store as new_intention since actions require tool execution context
        actions.push({ type: "new_intention", data: { content: `[ACTION] ${item}` } });
      }
    }
  }

  return actions;
}

/**
 * Execute parsed LLM actions: update beliefs, goal progress, intentions.
 */
async function executeLlmActions(
  agentId: string,
  agentDir: string,
  _workspaceDir: string,
  actions: LlmAction[],
  log: { info: (...args: any[]) => void; debug: (...args: any[]) => void },
): Promise<number> {
  let applied = 0;
  const now = new Date().toISOString();

  for (const action of actions) {
    try {
      switch (action.type) {
        case "belief_update": {
          const beliefsPath = join(agentDir, "Beliefs.md");
          let beliefs = await readMd(beliefsPath);
          if (!beliefs) {
            beliefs = `# Beliefs — ${agentId}\n\nLast updated: ${now}\n\n## Current Beliefs\n`;
          }
          const content = (action.data.content as string).replace(/^["']|["']$/g, ""); // strip quotes
          // Deduplicate: normalize quotes in existing text too before comparing
          const beliefsLower = beliefs.replace(/["']/g, "").toLowerCase();
          const contentLower = content.replace(/["']/g, "").toLowerCase();
          if (beliefsLower.includes(contentLower)) break;
          // Ensure ## Current Beliefs section exists
          if (!beliefs.includes("## Current Beliefs")) {
            // Insert before first ## section or at end
            const firstSection = beliefs.indexOf("\n## ");
            if (firstSection !== -1) {
              beliefs =
                beliefs.slice(0, firstSection) +
                `\n\n## Current Beliefs\n` +
                beliefs.slice(firstSection);
            } else {
              beliefs += `\n\n## Current Beliefs\n`;
            }
          }
          // Append to Current Beliefs section
          const currentIdx = beliefs.indexOf("## Current Beliefs");
          const nextSection = beliefs.indexOf("\n## ", currentIdx + 20);
          const insertAt = nextSection !== -1 ? nextSection : beliefs.length;
          beliefs = beliefs.slice(0, insertAt) + `\n- ${content}` + beliefs.slice(insertAt);
          beliefs = beliefs.replace(/Last updated: .*/, `Last updated: ${now}`);
          await writeMd(beliefsPath, beliefs);
          applied++;
          log.info(`[llm-action-executor] Belief added: ${content.slice(0, 80)}`);
          break;
        }
        case "goal_progress": {
          const goalsPath = join(agentDir, "Goals.md");
          let goals = await readMd(goalsPath);
          const goalId = action.data.goalId as string;
          const progress = action.data.progress as number;
          // Extract goal block and update progress
          const blockPattern = new RegExp(
            `(### ${goalId}:[\\s\\S]*?)(?=### G-|## Achieved|## Completed|## Failed|$)`,
          );
          const goalBlock = goals.match(blockPattern)?.[1];
          if (goalBlock) {
            let updatedBlock: string;
            if (goalBlock.includes("**Progress:**")) {
              updatedBlock = goalBlock.replace(
                /\*\*Progress:\*\*\s*\d+%/,
                `**Progress:** ${progress}%`,
              );
            } else {
              // Insert progress after Status line
              updatedBlock = goalBlock.replace(
                /(\*\*Status:\*\*\s*\w+)/,
                `$1\n- **Progress:** ${progress}%`,
              );
            }
            goals = goals.replace(goalBlock, updatedBlock);
            goals = goals.replace(/Last evaluated: .*/, `Last evaluated: ${now}`);
            await writeMd(goalsPath, goals);
            applied++;
            log.info(`[llm-action-executor] Goal ${goalId}: progress → ${progress}%`);

            // Sync matching intentions: update all executing intentions for this goal
            try {
              const intentionsPath = join(agentDir, "Intentions.md");
              let intentions = await readMd(intentionsPath);
              if (intentions) {
                let intentionsUpdated = false;
                // Split into blocks, update each that references this goal and is executing
                const intentionBlockPattern = new RegExp(
                  `(### [\\w-]+:\\s*${goalId}\\b[\\s\\S]*?)(?=### [\\w-]+:|## Completed|## Dropped|$)`,
                  "g",
                );
                intentions = intentions.replace(intentionBlockPattern, (block) => {
                  if (!/\*\*Status:\*\*\s*executing/i.test(block)) return block;
                  intentionsUpdated = true;
                  // Update progress
                  if (block.includes("**Progress:**")) {
                    block = block.replace(/\*\*Progress:\*\*\s*\d+%/, `**Progress:** ${progress}%`);
                  }
                  // Estimate step from progress (advance beyond S-1)
                  if (progress > 0 && block.includes("**Current Step:** S-1")) {
                    const step = Math.max(1, Math.ceil(progress / 20)); // S-1 at 0-20%, S-2 at 21-40%, etc.
                    block = block.replace(
                      /\*\*Current Step:\*\*\s*S-\d+/,
                      `**Current Step:** S-${step}`,
                    );
                  }
                  return block;
                });
                if (intentionsUpdated) {
                  intentions = intentions.replace(/Last updated: .*/, `Last updated: ${now}`);
                  await writeMd(intentionsPath, intentions);
                  log.info(
                    `[llm-action-executor] Synced intention progress for ${goalId} → ${progress}%`,
                  );
                }
              }
            } catch (err) {
              log.debug(`[llm-action-executor] Intention sync failed for ${goalId}: ${err}`);
            }
          } else {
            log.info(`[llm-action-executor] Goal ${goalId} not found in Goals.md`);
          }
          break;
        }
        case "new_intention": {
          // Log new intention recommendation to Memory.md for review
          const memPath = join(agentDir, "Memory.md");
          let mem = await readMd(memPath);
          const content = action.data.content as string;
          mem += `\n- [${now.split("T")[0]}] LLM recommended intention: ${content}`;
          await writeMd(memPath, mem);
          applied++;
          break;
        }
      }
    } catch (err) {
      log.info(`[llm-action-executor] Failed to apply ${action.type}: ${err}`);
    }
  }
  return applied;
}

/**
 * Compute and update goal progress from intention progress.
 */
async function updateGoalProgress(
  agentDir: string,
  log: { debug: (...args: any[]) => void },
): Promise<void> {
  const intentions = await readMd(join(agentDir, "Intentions.md"));
  const goals = await readMd(join(agentDir, "Goals.md"));
  if (!intentions || !goals) return;

  // Parse active intentions: extract goal_id + progress
  const intentionBlocks = intentions.split(/\n### I-/).slice(1);
  const goalProgress: Map<string, number[]> = new Map();

  for (const block of intentionBlocks) {
    const goalMatch = block.match(/(G-[\w-]+)/);
    const progMatch = block.match(/\*\*Progress:\*\*\s*(\d+)%/);
    const statusMatch = block.match(/\*\*Status:\*\*\s*(\w+)/);
    if (goalMatch && progMatch && statusMatch?.[1] === "executing") {
      const goalId = goalMatch[1];
      const prog = parseInt(progMatch[1]);
      if (!goalProgress.has(goalId)) goalProgress.set(goalId, []);
      goalProgress.get(goalId)!.push(prog);
    }
  }

  // Update Goals.md with computed progress from intentions
  // Only apply when intention progress > 0 to avoid overwriting LLM-set goal progress
  let updatedGoals = goals;
  for (const [goalId, progValues] of goalProgress) {
    const avg = Math.round(progValues.reduce((a, b) => a + b, 0) / progValues.length);
    if (avg === 0) continue; // Skip: don't overwrite LLM-set progress with 0%
    const blockPattern = new RegExp(
      `(### ${goalId}:[\\s\\S]*?)(?=### G-|## Achieved|## Completed|## Failed|$)`,
    );
    const goalBlock = updatedGoals.match(blockPattern)?.[1];
    if (goalBlock && goalBlock.includes("**Progress:**")) {
      const updatedBlock = goalBlock.replace(/\*\*Progress:\*\*\s*\d+%/, `**Progress:** ${avg}%`);
      updatedGoals = updatedGoals.replace(goalBlock, updatedBlock);
    }
  }

  if (updatedGoals !== goals) {
    await writeMd(join(agentDir, "Goals.md"), updatedGoals);
    log.debug(`[cognitive-router] Updated goal progress for ${goalProgress.size} goal(s)`);
  }
}

// ── Router State Management ───────────────────────────────────

function routerStatePath(workspaceDir: string): string {
  return join(workspaceDir, "cognitive-router-state.json");
}

async function loadRouterState(workspaceDir: string): Promise<CognitiveRouterState> {
  const state = await readJson(routerStatePath(workspaceDir));
  return state || { version: 0, updatedAt: new Date().toISOString(), agents: {} };
}

async function saveRouterState(workspaceDir: string, state: CognitiveRouterState): Promise<void> {
  state.version++;
  state.updatedAt = new Date().toISOString();
  await writeJson(routerStatePath(workspaceDir), state);
}

function getAgentRouterState(state: CognitiveRouterState, agentId: string): AgentRouterState {
  return (
    state.agents[agentId] || {
      lastHeartbeatAt: new Date(0).toISOString(),
      lastFullCycleAt: new Date(0).toISOString(),
      consecutiveReflexive: 0,
      lastDepth: "reflexive" as ProcessingDepth,
      lastDemandScore: 0,
    }
  );
}

// ── Resolve Thresholds ────────────────────────────────────────

async function resolveThresholds(agentDir: string, role: string): Promise<RoleThresholds> {
  // Check agent.json for custom thresholds
  const agentConfig = await readJson(join(agentDir, "agent.json"));
  const custom = agentConfig?.bdi?.cognitiveRouter?.thresholds;
  const base = DEFAULT_ROLE_THRESHOLDS[role] || DEFAULT_SUBAGENT_THRESHOLDS;

  // Merge cycle frequency from agent config
  const cycleFreq = agentConfig?.bdi?.cycleFrequency;
  const merged: RoleThresholds = {
    ...base,
    fullCycleMinutes: cycleFreq?.fullCycleMinutes ?? base.fullCycleMinutes,
    quickCheckMinutes: cycleFreq?.quickCheckMinutes ?? base.quickCheckMinutes,
    commitmentStrategy: agentConfig?.bdi?.commitmentStrategy ?? base.commitmentStrategy,
  };

  if (custom) {
    return { ...merged, ...custom };
  }
  return merged;
}

// ── Enhanced Heartbeat ────────────────────────────────────────

/**
 * Enhanced heartbeat cycle that replaces the flat maintenance loop.
 * For each agent: scan signals → compute demand → select depth →
 * process with escalation → run maintenance → record results.
 */
export async function enhancedHeartbeatCycle(
  workspaceDir: string,
  api: OpenClawPluginApi,
  log: {
    info: (...args: any[]) => void;
    debug: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  },
): Promise<void> {
  const agentsDir = join(workspaceDir, "agents");
  let agentIds: string[] = [];

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    agentIds = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    log.debug("[cognitive-router] No agents directory found");
    return;
  }

  if (agentIds.length === 0) return;

  const routerState = await loadRouterState(workspaceDir);
  const now = new Date().toISOString();

  for (const agentId of agentIds) {
    try {
      const agentDir = join(agentsDir, agentId);
      const agentState = getAgentRouterState(routerState, agentId);

      // Resolve role from agent.json
      const agentConfig = await readJson(join(agentDir, "agent.json"));
      const role = agentConfig?.id || agentId;

      // Check if cognitive router is enabled for this agent
      const routerConfig = agentConfig?.bdi?.cognitiveRouter as CognitiveRouterConfig | undefined;
      if (routerConfig?.enabled === false) {
        // Skip cognitive routing for this agent, fall through to legacy maintenance
        continue;
      }

      const thresholds = await resolveThresholds(agentDir, role);

      // 1. Scan all signals
      const signals = await scanAllSignals(agentDir, agentId, agentState.lastHeartbeatAt);

      // 2. Compute demand
      const demand = computeCognitiveDemand(signals, thresholds, agentState.lastFullCycleAt);

      // 3. Select depth
      let depth = selectDepth(demand.score, thresholds);
      depth = applyDepthOverrides(depth, signals, agentState.consecutiveReflexive, thresholds);

      // 4. Process with escalation cascade
      const result = await processWithEscalation(
        agentId,
        agentDir,
        role,
        depth,
        signals,
        thresholds,
        api,
      );

      // 5. Process inbox responses (reply to REQUEST/QUERY, mark messages read)
      try {
        await processInboxResponses(agentId, agentDir, workspaceDir, signals, result, log, api);
      } catch (err) {
        log.warn?.(
          `[cognitive-router] Inbox response error for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 5b. Execute reflexive actions (assert facts, log actions, send messages)
      if (
        result.depth === "reflexive" &&
        result._reflexiveActions &&
        result._reflexiveActions.length > 0
      ) {
        try {
          const applied = await executeReflexiveActions(
            agentId,
            agentDir,
            workspaceDir,
            result._reflexiveActions,
            log,
          );
          log.debug(`[cognitive-router] ${agentId}: applied ${applied} reflexive action(s)`);
        } catch (err) {
          log.warn?.(
            `[cognitive-router] Reflexive action error for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 5c. Parse and execute LLM-recommended actions (analytical/deliberative)
      if (result.depth !== "reflexive" && result.conclusion) {
        try {
          // Log first 500 chars of conclusion for observability
          log.info(
            `[cognitive-router] ${agentId} (${result.depth}): conclusion preview: ${result.conclusion.slice(0, 500).replace(/\n/g, " | ")}`,
          );
          const llmActions = parseLlmActions(result.conclusion);
          log.info(
            `[cognitive-router] ${agentId}: parsed ${llmActions.length} action(s): ${llmActions.map((a) => `${a.type}${a.type === "goal_progress" ? `(${(a.data as any).goalId})` : ""}`).join(", ") || "none"}`,
          );
          if (llmActions.length > 0) {
            const applied = await executeLlmActions(
              agentId,
              agentDir,
              workspaceDir,
              llmActions,
              log,
            );
            log.info(`[cognitive-router] ${agentId}: applied ${applied} LLM action(s)`);
          }
        } catch (err) {
          log.warn?.(
            `[cognitive-router] LLM action error for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 5d. Update goal progress from intention completion
      try {
        await updateGoalProgress(agentDir, log);
      } catch {
        /* non-critical */
      }

      // 6. Update router state
      const newAgentState: AgentRouterState = {
        lastHeartbeatAt: now,
        lastFullCycleAt: result.depth === "deliberative" ? now : agentState.lastFullCycleAt,
        consecutiveReflexive:
          result.depth === "reflexive" ? agentState.consecutiveReflexive + 1 : 0,
        lastDepth: result.depth,
        lastDemandScore: demand.score,
      };
      routerState.agents[agentId] = newAgentState;

      // 7. Also run legacy maintenance (prune intentions, sort desires)
      try {
        const BDI_RUNTIME_PATH = "../../mabos/bdi-runtime/index.js";
        const { readAgentCognitiveState, runMaintenanceCycle } = (await import(
          /* webpackIgnore: true */ BDI_RUNTIME_PATH
        )) as any;
        const state = await readAgentCognitiveState(agentDir, agentId);
        const cycleResult = await runMaintenanceCycle(state);

        // Fire-and-forget TypeDB write
        import("../knowledge/typedb-dashboard.js")
          .then(({ writeBdiCycleResultToTypeDB }) =>
            writeBdiCycleResultToTypeDB(agentId, "mabos", {
              newIntentions: cycleResult?.newIntentions,
              newBeliefs: cycleResult?.newBeliefs,
              updatedGoals: cycleResult?.updatedGoals,
            }),
          )
          .catch(() => {});
      } catch {
        // Legacy maintenance unavailable — not critical
      }

      log.debug(
        `[cognitive-router] ${agentId}: depth=${result.depth}, demand=${demand.score.toFixed(2)}, confidence=${result.confidence.toFixed(2)}, signals=${signals.length}${result.escalated ? ` (escalated from ${result.escalationHistory.join("→")})` : ""}`,
      );
    } catch (err) {
      log.warn?.(
        `[cognitive-router] Error processing ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Save updated router state
  await saveRouterState(workspaceDir, routerState);
}

// ── Tool Definitions ──────────────────────────────────────────

const CognitiveDemandParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to assess demand for" }),
});

const CognitiveRouteParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to route" }),
  force_depth: Type.Optional(
    Type.Union(
      [Type.Literal("reflexive"), Type.Literal("analytical"), Type.Literal("deliberative")],
      { description: "Force a specific processing depth (overrides auto-selection)" },
    ),
  ),
});

const CognitiveStatusParams = Type.Object({
  agent_id: Type.Optional(
    Type.String({ description: "Agent ID to inspect (omit for all agents)" }),
  ),
});

export function createCognitiveRouterTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "cognitive_demand",
      label: "Assess Cognitive Demand",
      description:
        "Diagnostic: assess the current cognitive demand score and recommended processing depth for an agent based on its signals, role thresholds, and cycle history.",
      parameters: CognitiveDemandParams,
      async execute(_id: string, params: Static<typeof CognitiveDemandParams>) {
        const workspaceDir = resolveWorkspaceDir(api);
        const agentDir = join(workspaceDir, "agents", params.agent_id);
        const role = params.agent_id;
        const thresholds = await resolveThresholds(agentDir, role);
        const routerState = await loadRouterState(workspaceDir);
        const agentState = getAgentRouterState(routerState, params.agent_id);

        const signals = await scanAllSignals(agentDir, params.agent_id, agentState.lastHeartbeatAt);

        const demand = computeCognitiveDemand(signals, thresholds, agentState.lastFullCycleAt);

        let depth = selectDepth(demand.score, thresholds);
        depth = applyDepthOverrides(depth, signals, agentState.consecutiveReflexive, thresholds);

        const signalBreakdown = signals
          .slice(0, 10)
          .map(
            (s) =>
              `- [${s.source}] ${s.summary} (u=${s.urgency.toFixed(2)}, s=${s.stakes.toFixed(2)}, n=${s.novelty.toFixed(2)})`,
          )
          .join("\n");

        return textResult(`## Cognitive Demand — ${params.agent_id}

**Demand Score:** ${demand.score.toFixed(3)}
**Recommended Depth:** ${depth}
**Signal Count:** ${demand.signalCount}

### Score Breakdown
| Component | Value | Weight |
|-----------|-------|--------|
| Urgency | ${demand.breakdown.urgency.toFixed(3)} | 0.30 |
| Stakes | ${demand.breakdown.stakes.toFixed(3)} | 0.30 |
| Novelty | ${demand.breakdown.novelty.toFixed(3)} | 0.15 |
| Volume | ${demand.breakdown.volume.toFixed(3)} | 0.10 |
| Recency | ${demand.breakdown.recency.toFixed(3)} | 0.15 |

### Role Thresholds
- Reflexive ceiling: ${thresholds.reflexiveCeiling}
- Deliberative floor: ${thresholds.deliberativeFloor}
- Max consecutive reflexive: ${thresholds.maxConsecutiveReflexive}
- Current consecutive reflexive: ${agentState.consecutiveReflexive}

### Top Signals
${signalBreakdown || "No pending signals."}

### Peak Signal
${demand.peakSignal ? demand.peakSignal.summary : "None"}`);
      },
    },

    {
      name: "cognitive_route",
      label: "Trigger Cognitive Routing",
      description:
        "On-demand: trigger the cognitive router for an agent outside the regular heartbeat cycle. Optionally force a specific depth.",
      parameters: CognitiveRouteParams,
      async execute(_id: string, params: Static<typeof CognitiveRouteParams>) {
        const workspaceDir = resolveWorkspaceDir(api);
        const agentDir = join(workspaceDir, "agents", params.agent_id);
        const role = params.agent_id;
        const thresholds = await resolveThresholds(agentDir, role);
        const routerState = await loadRouterState(workspaceDir);
        const agentState = getAgentRouterState(routerState, params.agent_id);

        const signals = await scanAllSignals(agentDir, params.agent_id, agentState.lastHeartbeatAt);

        const demand = computeCognitiveDemand(signals, thresholds, agentState.lastFullCycleAt);

        let depth: ProcessingDepth;
        if (params.force_depth) {
          depth = params.force_depth;
        } else {
          depth = selectDepth(demand.score, thresholds);
          depth = applyDepthOverrides(depth, signals, agentState.consecutiveReflexive, thresholds);
        }

        const result = await processWithEscalation(
          params.agent_id,
          agentDir,
          role,
          depth,
          signals,
          thresholds,
          api,
        );

        // Process inbox responses (reply + mark read)
        const routeLog = {
          debug: () => {},
          warn: () => {},
        };
        await processInboxResponses(
          params.agent_id,
          agentDir,
          workspaceDir,
          signals,
          result,
          routeLog,
          api,
        );

        // Update state
        const now = new Date().toISOString();
        routerState.agents[params.agent_id] = {
          lastHeartbeatAt: now,
          lastFullCycleAt: result.depth === "deliberative" ? now : agentState.lastFullCycleAt,
          consecutiveReflexive:
            result.depth === "reflexive" ? agentState.consecutiveReflexive + 1 : 0,
          lastDepth: result.depth,
          lastDemandScore: demand.score,
        };
        await saveRouterState(workspaceDir, routerState);

        return textResult(`## Cognitive Route — ${params.agent_id}

**Demand:** ${demand.score.toFixed(3)} | **Depth:** ${result.depth}${params.force_depth ? " (forced)" : ""} | **Confidence:** ${result.confidence.toFixed(2)}
**Signals:** ${signals.length} | **Methods:** ${result.methodsUsed.join(", ")}
${result.escalated ? `**Escalated:** ${result.escalationHistory.join(" → ")} → ${result.depth}` : ""}

### Reasoning Trace
${result.reasoningTrace.map((t) => `- ${t}`).join("\n")}

### Result
${result.conclusion}`);
      },
    },

    {
      name: "cognitive_status",
      label: "Cognitive Router Status",
      description:
        "Inspection: view the cognitive router state for one or all agents — last depth, demand score, consecutive reflexive count, cycle timestamps.",
      parameters: CognitiveStatusParams,
      async execute(_id: string, params: Static<typeof CognitiveStatusParams>) {
        const workspaceDir = resolveWorkspaceDir(api);
        const state = await loadRouterState(workspaceDir);

        if (params.agent_id) {
          const agentState = state.agents[params.agent_id];
          if (!agentState) {
            return textResult(`No router state found for agent '${params.agent_id}'.`);
          }

          return textResult(`## Cognitive Router State — ${params.agent_id}

| Field | Value |
|-------|-------|
| Last Heartbeat | ${agentState.lastHeartbeatAt} |
| Last Full Cycle | ${agentState.lastFullCycleAt} |
| Last Depth | ${agentState.lastDepth} |
| Last Demand Score | ${agentState.lastDemandScore.toFixed(3)} |
| Consecutive Reflexive | ${agentState.consecutiveReflexive} |`);
        }

        // All agents
        const agents = Object.entries(state.agents);
        if (agents.length === 0) {
          return textResult("No cognitive router state recorded yet.");
        }

        const rows = agents
          .map(
            ([id, s]) =>
              `| ${id} | ${s.lastDepth} | ${s.lastDemandScore.toFixed(3)} | ${s.consecutiveReflexive} | ${s.lastHeartbeatAt.split("T")[0]} |`,
          )
          .join("\n");

        return textResult(`## Cognitive Router State (all agents)

**State version:** ${state.version} | **Updated:** ${state.updatedAt}

| Agent | Last Depth | Demand | Consec. Reflexive | Last Heartbeat |
|-------|-----------|--------|-------------------|----------------|
${rows}`);
      },
    },
  ];
}
