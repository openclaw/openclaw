/**
 * Intelligent session selection for Claude Code spawns.
 *
 * Replaces naive `resolveSession()` registry lookup with a 5-factor scoring
 * model that considers branch match, recency, task relevance (LLM-scored),
 * session health, and context capacity.
 */

import type { ProjectStatus } from "./project-status.js";
import type { DiscoveredSession, SessionSelectionConfig } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveSession } from "./sessions.js";

const log = createSubsystemLogger("agent/claude-code/session-selection");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_SELECTION_CONFIG: SessionSelectionConfig = {
  relevanceModel: "claude-haiku",
  relevanceMaxTokens: 500,
  relevanceTimeoutMs: 3000,
  resumeThreshold: 0.6,
  enabled: true,
};

const HARD_CEILING_COMPACTIONS = 3;
const HARD_CEILING_BUDGET_PCT = 0.7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskRelevanceResult = {
  sessionId: string;
  relevance: number;
  reasoning: string;
};

export type ScoreFactors = {
  branchMatch: number;
  recency: number;
  taskRelevance: number;
  sessionHealth: number;
  contextCapacity: number;
};

export type SessionScore = {
  sessionId: string;
  score: number;
  factors: ScoreFactors;
  recommendation: "resume" | "fresh";
  reason: string;
};

export type SessionSelection = {
  action: "resume" | "fresh" | "queue";
  sessionId?: string;
  reason: string;
  scores?: SessionScore[];
};

// ---------------------------------------------------------------------------
// LLM-based task relevance
// ---------------------------------------------------------------------------

/** Map friendly model names to actual API model IDs. */
function resolveModelId(model: string): string {
  const aliases: Record<string, string> = {
    "claude-haiku": "claude-haiku-4-5-20251001",
    "claude-sonnet": "claude-sonnet-4-6-20250514",
    "claude-opus": "claude-opus-4-6-20250514",
  };
  return aliases[model] ?? model;
}

/**
 * Call Anthropic Messages API for task relevance scoring.
 * Uses ANTHROPIC_API_KEY from environment. Falls back to keyword matching
 * if no API key is available.
 */
async function callAnthropicApi(prompt: string, config: SessionSelectionConfig): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not available");
  }

  const modelId = resolveModelId(config.relevanceModel);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.relevanceTimeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: config.relevanceMaxTokens,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((b) => b.type === "text")?.text;
    if (!text) {
      throw new Error("No text in API response");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract JSON array from LLM response text, handling markdown code fences. */
function extractJson(text: string): string {
  // Try to extract JSON from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // Try to find a JSON array directly
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }
  return text;
}

/**
 * Score task relevance for all candidate sessions in one batched LLM call.
 * Falls back to keyword Jaccard if LLM is disabled or fails.
 */
export async function assessTaskRelevance(
  task: string,
  sessions: DiscoveredSession[],
  config: SessionSelectionConfig = DEFAULT_SESSION_SELECTION_CONFIG,
): Promise<TaskRelevanceResult[]> {
  if (sessions.length === 0) {
    return [];
  }

  if (!config.enabled) {
    return sessions.map((s) => keywordFallback(task, s));
  }

  const sessionDescriptions = sessions
    .map((s, i) => {
      const desc = s.lastTask ?? s.firstMessage ?? "(no description)";
      const branch = s.branch ?? "unknown";
      return `${i + 1}. [branch: ${branch}] ${desc}`;
    })
    .join("\n");

  const prompt = `You are scoring task relevance for session selection.

NEW TASK: ${task}

EXISTING SESSIONS:
${sessionDescriptions}

For each session, rate how relevant its previous work is to the new task.
Consider: same feature area? same files likely touched? shared context valuable?
A session about "refactor webhook handler" IS relevant to "fix webhook error handling".
A session about "add OAuth" is NOT relevant to "update README formatting".

Return JSON array: [{"index": 1, "relevance": 0.0-1.0, "reasoning": "one line"}]
Relevance scale: 0.0 = unrelated, 0.3 = tangentially related, 0.6 = related work, 0.9 = same feature/task, 1.0 = exact continuation.`;

  try {
    const response = await callAnthropicApi(prompt, config);
    const scores = JSON.parse(extractJson(response)) as Array<{
      index: number;
      relevance: number;
      reasoning: string;
    }>;

    return scores.map((s) => ({
      sessionId: sessions[s.index - 1]?.sessionId ?? "",
      relevance: Math.min(Math.max(s.relevance, 0), 1),
      reasoning: s.reasoning,
    }));
  } catch (err) {
    log.warn(
      `Task relevance LLM call failed, falling back to keyword matching: ${err instanceof Error ? err.message : String(err)}`,
    );
    return sessions.map((s) => keywordFallback(task, s));
  }
}

/**
 * Keyword Jaccard similarity fallback when LLM is disabled or fails.
 */
export function keywordFallback(task: string, session: DiscoveredSession): TaskRelevanceResult {
  const taskWords = new Set(
    task
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  const sessionText = session.lastTask ?? session.firstMessage ?? "";
  const sessionWords = new Set(
    sessionText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  const intersection = [...taskWords].filter((w) => sessionWords.has(w));
  const union = new Set([...taskWords, ...sessionWords]);
  const jaccard = union.size > 0 ? intersection.length / union.size : 0;
  return {
    sessionId: session.sessionId,
    relevance: Math.min(jaccard * 2, 1),
    reasoning: `keyword overlap: ${intersection.length}/${union.size} words`,
  };
}

// ---------------------------------------------------------------------------
// Scoring function
// ---------------------------------------------------------------------------

/**
 * Score a single session against a task using 5 factors.
 * Total max 1.0, clamped to minimum 0.
 */
export function scoreSession(
  session: DiscoveredSession,
  _task: string,
  currentBranch: string,
  relevance: TaskRelevanceResult,
  _maxBudgetUsd?: number,
): SessionScore {
  // Hard ceiling: 3+ compactions = context too degraded
  if (session.compactionCount >= HARD_CEILING_COMPACTIONS) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — session compacted ${session.compactionCount} times (context too degraded)`,
    };
  }

  // Hard ceiling: 70%+ budget consumed
  if (session.budgetUsedPct != null && session.budgetUsedPct >= HARD_CEILING_BUDGET_PCT) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — session used ${(session.budgetUsedPct * 100).toFixed(0)}% of budget`,
    };
  }

  // Soft ceiling: unrelated task + large session
  if (relevance.relevance < 0.1 && session.messageCount > 200) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — unrelated task (${relevance.reasoning}) + large session (${session.messageCount} messages)`,
    };
  }

  const factors: ScoreFactors = {
    branchMatch: 0,
    recency: 0,
    taskRelevance: 0,
    sessionHealth: 0,
    contextCapacity: 0,
  };

  // 1. Branch match (0.25)
  if (session.branch === currentBranch) {
    factors.branchMatch = 0.25;
  }

  // 2. Recency (0.0 - 0.20) — exponential decay
  const ageHours = (Date.now() - session.lastModified.getTime()) / (1000 * 60 * 60);
  if (ageHours < 1) {
    factors.recency = 0.2;
  } else if (ageHours < 6) {
    factors.recency = 0.16;
  } else if (ageHours < 24) {
    factors.recency = 0.12;
  } else if (ageHours < 72) {
    factors.recency = 0.08;
  } else if (ageHours < 168) {
    factors.recency = 0.04;
  } else {
    factors.recency = 0;
  }

  // 3. Task relevance (-0.15 to 0.25)
  if (relevance.relevance >= 0.6) {
    factors.taskRelevance = 0.25;
  } else if (relevance.relevance >= 0.3) {
    factors.taskRelevance = 0.1 + (relevance.relevance - 0.3) * 0.5;
  } else if (relevance.relevance >= 0.1) {
    factors.taskRelevance = 0;
  } else {
    factors.taskRelevance = -0.15;
  }

  // 4. Session health (0.0 - 0.15)
  let health = 0.15;
  if (session.messageCount > 500) {
    health -= 0.07;
  }
  if (session.fileSizeBytes > 5_000_000) {
    health -= 0.04;
  }
  if (ageHours > 168) {
    health -= 0.04;
  }
  factors.sessionHealth = Math.max(health, 0);

  // 5. Context capacity (0.0 - 0.15)
  let capacity = 0.15;
  if (session.compactionCount === 1) {
    capacity -= 0.04;
  } else if (session.compactionCount === 2) {
    capacity -= 0.09;
  }
  if (session.budgetUsedPct != null) {
    if (session.budgetUsedPct > 0.5) {
      capacity -= 0.04;
    } else if (session.budgetUsedPct > 0.3) {
      capacity -= 0.02;
    }
  }
  const totalTokens = session.totalInputTokens + session.totalOutputTokens;
  const tokensPerMessage = session.messageCount > 0 ? totalTokens / session.messageCount : 0;
  if (tokensPerMessage > 4000) {
    capacity -= 0.03;
  }
  factors.contextCapacity = Math.max(capacity, 0);

  const score = Math.max(
    0,
    factors.branchMatch +
      factors.recency +
      factors.taskRelevance +
      factors.sessionHealth +
      factors.contextCapacity,
  );

  const threshold = DEFAULT_SESSION_SELECTION_CONFIG.resumeThreshold;
  return {
    sessionId: session.sessionId,
    score,
    factors,
    recommendation: score >= threshold ? "resume" : "fresh",
    reason: buildReason(factors, score, session, relevance, threshold),
  };
}

function buildReason(
  factors: ScoreFactors,
  score: number,
  session: DiscoveredSession,
  relevance: TaskRelevanceResult,
  threshold: number,
): string {
  const parts: string[] = [];
  if (factors.branchMatch > 0) {
    parts.push("same branch");
  }
  if (factors.recency >= 0.16) {
    parts.push("recent");
  } else if (factors.recency === 0) {
    parts.push("stale (>1 week)");
  }
  if (factors.taskRelevance >= 0.15) {
    parts.push(`related: ${relevance.reasoning}`);
  } else if (factors.taskRelevance < 0) {
    parts.push(`unrelated: ${relevance.reasoning}`);
  }
  if (factors.sessionHealth < 0.08) {
    parts.push("large/unhealthy session");
  }
  if (factors.contextCapacity < 0.08) {
    parts.push("low context capacity");
  }
  if (session.compactionCount > 0) {
    parts.push(`${session.compactionCount}x compacted`);
  }
  if (session.budgetUsedPct != null && session.budgetUsedPct > 0.3) {
    parts.push(`${(session.budgetUsedPct * 100).toFixed(0)}% budget used`);
  }

  const action = score >= threshold ? "Resume" : "Start fresh";
  return `${action} (score: ${score.toFixed(2)}) — ${parts.join(", ") || "no strong signals"}`;
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Select the best session strategy for a new task.
 *
 * Decision tree:
 * 1. Label provided → direct resolveSession() lookup
 * 2. Active session on repo → queue (existing behavior)
 * 3. No own sessions → fresh
 * 4. Score all own sessions → best above threshold = resume, otherwise fresh
 */
export async function selectSession(
  task: string,
  repoPath: string,
  agentId: string,
  projectStatus: ProjectStatus,
  label?: string,
  maxBudgetUsd?: number,
  config?: Partial<SessionSelectionConfig>,
): Promise<SessionSelection> {
  const selectionConfig: SessionSelectionConfig = {
    ...DEFAULT_SESSION_SELECTION_CONFIG,
    ...config,
  };

  // Labeled sessions: direct lookup (preserved from existing behavior)
  if (label) {
    const existing = resolveSession(agentId, repoPath, label);
    if (existing) {
      return { action: "resume", sessionId: existing, reason: `Labeled session "${label}"` };
    }
    return { action: "fresh", reason: `New labeled session "${label}"` };
  }

  // Active session: queue (existing behavior)
  if (projectStatus.sessions.active.length > 0) {
    return { action: "queue", reason: "Active session running on this repo" };
  }

  // Score all own sessions
  const ownSessions = projectStatus.sessions.recent.filter((s) => s.agentId === agentId);
  if (ownSessions.length === 0) {
    return { action: "fresh", reason: "No previous sessions found" };
  }

  // LLM-based semantic relevance — one call for all candidates
  let relevanceResults: TaskRelevanceResult[];
  try {
    relevanceResults = await assessTaskRelevance(task, ownSessions, selectionConfig);
  } catch (err) {
    log.warn(
      `Task relevance scoring failed, falling back to keyword matching: ${err instanceof Error ? err.message : String(err)}`,
    );
    relevanceResults = ownSessions.map((s) => keywordFallback(task, s));
  }

  const relevanceMap = new Map(relevanceResults.map((r) => [r.sessionId, r]));

  const scores = ownSessions.map((s) =>
    scoreSession(
      s,
      task,
      projectStatus.git.currentBranch,
      relevanceMap.get(s.sessionId) ?? {
        sessionId: s.sessionId,
        relevance: 0.5,
        reasoning: "unknown",
      },
      maxBudgetUsd,
    ),
  );
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (best.score >= selectionConfig.resumeThreshold) {
    log.info(`Session selection: resume ${best.sessionId} — ${best.reason}`);
    return {
      action: "resume",
      sessionId: best.sessionId,
      reason: best.reason,
      scores,
    };
  }

  log.info(`Session selection: fresh — ${best.reason}`);
  return { action: "fresh", reason: best.reason, scores };
}
