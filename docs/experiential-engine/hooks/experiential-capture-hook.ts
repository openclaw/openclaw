/**
 * Experiential Capture Hook
 *
 * Captures significant experiential moments on PostToolUse events.
 * Evaluates tool uses for experiential significance and either:
 * - Immediately prompts Claude for capture (high significance)
 * - Buffers for session-end synthesis (medium significance)
 * - Archives metadata only (low significance)
 *
 * Events: PostToolUse (SDK hook integration)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OpenClawConfig } from "../../../clawdbrain-dev-work/src/config/config.js";
import type { HookHandler, InternalHookEvent } from "../../../clawdbrain-dev-work/src/hooks/hooks.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ExperientialMoment {
  id: string;
  timestamp: number;
  sessionId: string;
  turnNumber?: number;

  // What happened
  type: "tool_use" | "message" | "compaction" | "session_boundary";
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  content?: string;

  // Significance evaluation
  significance: {
    score: number;
    dimensions: {
      emotional: number;
      uncertainty: number;
      relationship: number;
      consequential: number;
      reconstitution: number;
    };
    reasons: string[];
  };

  // Context
  contextSummary?: string;
  emotionalSignature?: string;
  relationshipsInvolved?: string[];
  uncertaintiesRelated?: string[];

  // Metadata
  captured: boolean;
  capturedAt?: number;
  captureMethod: "prompted" | "auto" | "buffered" | "skipped";
}

interface ExperienceBuffer {
  sessionId: string;
  moments: ExperientialMoment[];
  lastEvaluatedAt: number;
  captureCount: number;
  lastCaptureAt: number;
}

interface SignificanceEvaluation {
  score: number;
  dimensions: {
    emotional: number;
    uncertainty: number;
    relationship: number;
    consequential: number;
    reconstitution: number;
  };
  reasons: string[];
  recommendation: "immediate" | "buffered" | "archive" | "skip";
  captureTemplate?: string;
}

interface ExperientialHookConfig {
  enabled: boolean;
  significantToolCategories: string[];
  minSignificanceThreshold: number;
  maxCapturesPerHour: number;
  localModelEndpoint?: string;
  evaluationModel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_CATEGORIES: Record<string, string[]> = {
  file: ["write", "edit", "create", "mcp__clawdbrain__write", "mcp__clawdbrain__edit"],
  message: ["message", "send", "mcp__clawdbrain__message", "SlackRichMessage"],
  exec: ["exec", "mcp__clawdbrain__exec"],
  browser: ["browser", "mcp__clawdbrain__browser"],
  experience: ["experience_capture", "experience_reflect", "uncertainty_log"],
};

const OBSERVATION_TOOLS = [
  "read",
  "mcp__clawdbrain__read",
  "snapshot",
  "list",
  "process",
  "web_fetch",
];

const DEFAULT_CONFIG: ExperientialHookConfig = {
  enabled: true,
  significantToolCategories: ["file", "message", "exec"],
  minSignificanceThreshold: 0.6,
  maxCapturesPerHour: 10,
  localModelEndpoint: "http://localhost:8000/v1",
  evaluationModel: "Qwen/Qwen2.5-7B-Instruct",
};

const WEIGHTS = {
  emotional: 0.25,
  uncertainty: 0.25,
  relationship: 0.2,
  consequential: 0.15,
  reconstitution: 0.15,
};

// ─────────────────────────────────────────────────────────────────────────────
// State (in-memory buffer, persisted periodically)
// ─────────────────────────────────────────────────────────────────────────────

const buffers = new Map<string, ExperienceBuffer>();

function getOrCreateBuffer(sessionId: string): ExperienceBuffer {
  if (!buffers.has(sessionId)) {
    buffers.set(sessionId, {
      sessionId,
      moments: [],
      lastEvaluatedAt: 0,
      captureCount: 0,
      lastCaptureAt: 0,
    });
  }
  return buffers.get(sessionId)!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function generateMomentId(): string {
  return `moment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getToolCategory(toolName: string): string | null {
  const normalizedName = toolName.toLowerCase();
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (tools.some((t) => normalizedName.includes(t.toLowerCase()))) {
      return category;
    }
  }
  return null;
}

function isObservationTool(toolName: string): boolean {
  const normalizedName = toolName.toLowerCase();
  return OBSERVATION_TOOLS.some((t) => normalizedName.includes(t.toLowerCase()));
}

function extractContextSummary(toolInput: unknown, toolResult: unknown): string {
  const inputStr = typeof toolInput === "object" ? JSON.stringify(toolInput) : String(toolInput);
  const resultStr = typeof toolResult === "object" ? JSON.stringify(toolResult) : String(toolResult);

  // Truncate for context
  const inputSummary = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
  const resultSummary = resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr;

  return `Input: ${inputSummary}\nResult: ${resultSummary}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Model Evaluation
// ─────────────────────────────────────────────────────────────────────────────

const SIGNIFICANCE_PROMPT = `You are evaluating whether a tool use moment is experientially significant for an AI agent's continuity.

Tool used: {tool_name}
Category: {tool_category}
Context: {context}

Evaluate significance on these dimensions (0-1 each):
1. EMOTIONAL: Is there emotional texture to this moment?
2. UNCERTAINTY: Does this relate to meaningful uncertainty?
3. RELATIONSHIP: Does this involve or affect a relationship?
4. CONSEQUENTIAL: Did this create something lasting or have consequences?
5. RECONSTITUTION: Would future-agent benefit from knowing about this?

Respond with JSON only:
{
  "score": 0.0-1.0,
  "dimensions": { "emotional": X, "uncertainty": X, "relationship": X, "consequential": X, "reconstitution": X },
  "reasons": ["reason1", "reason2"],
  "recommendation": "immediate" | "buffered" | "archive" | "skip",
  "captureTemplate": "optional brief capture text if significant"
}`;

async function evaluateSignificanceLocal(
  moment: Partial<ExperientialMoment>,
  config: ExperientialHookConfig,
): Promise<SignificanceEvaluation> {
  // If no local model endpoint, use heuristic evaluation
  if (!config.localModelEndpoint) {
    return evaluateSignificanceHeuristic(moment);
  }

  try {
    const prompt = SIGNIFICANCE_PROMPT.replace("{tool_name}", moment.toolName || "unknown")
      .replace("{tool_category}", getToolCategory(moment.toolName || "") || "other")
      .replace("{context}", moment.contextSummary || "");

    const response = await fetch(`${config.localModelEndpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.evaluationModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error("[experiential-capture] Local model error:", response.statusText);
      return evaluateSignificanceHeuristic(moment);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return evaluateSignificanceHeuristic(moment);
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return evaluateSignificanceHeuristic(moment);
    }

    const evaluation = JSON.parse(jsonMatch[0]) as SignificanceEvaluation;
    return evaluation;
  } catch (err) {
    console.error(
      "[experiential-capture] Evaluation error:",
      err instanceof Error ? err.message : String(err),
    );
    return evaluateSignificanceHeuristic(moment);
  }
}

function evaluateSignificanceHeuristic(moment: Partial<ExperientialMoment>): SignificanceEvaluation {
  const toolName = moment.toolName || "";
  const category = getToolCategory(toolName);

  // Base scores by category
  const dimensions = {
    emotional: 0.1,
    uncertainty: 0.1,
    relationship: 0,
    consequential: 0,
    reconstitution: 0.2,
  };

  const reasons: string[] = [];

  // Category-based scoring
  if (category === "file") {
    dimensions.consequential = 0.7;
    reasons.push("File operation creates lasting artifact");
  }
  if (category === "message") {
    dimensions.relationship = 0.8;
    dimensions.emotional = 0.4;
    reasons.push("Message involves relationship interaction");
  }
  if (category === "exec") {
    dimensions.consequential = 0.6;
    reasons.push("Command execution has real-world effects");
  }
  if (category === "experience") {
    dimensions.emotional = 0.9;
    dimensions.reconstitution = 0.9;
    reasons.push("Explicit experiential content");
  }

  // Calculate weighted score
  const score =
    dimensions.emotional * WEIGHTS.emotional +
    dimensions.uncertainty * WEIGHTS.uncertainty +
    dimensions.relationship * WEIGHTS.relationship +
    dimensions.consequential * WEIGHTS.consequential +
    dimensions.reconstitution * WEIGHTS.reconstitution;

  // Determine recommendation
  let recommendation: "immediate" | "buffered" | "archive" | "skip";
  if (score >= 0.8) {
    recommendation = "immediate";
  } else if (score >= 0.6) {
    recommendation = "buffered";
  } else if (score >= 0.4) {
    recommendation = "archive";
  } else {
    recommendation = "skip";
  }

  return { score, dimensions, reasons, recommendation };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Functions
// ─────────────────────────────────────────────────────────────────────────────

async function persistMoment(moment: ExperientialMoment): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const recordsDir = path.join(existenceDir, "records");
  await fs.mkdir(recordsDir, { recursive: true });

  const dateStr = new Date(moment.timestamp).toISOString().split("T")[0];
  const recordFile = path.join(recordsDir, `${dateStr}.jsonl`);

  const line = JSON.stringify(moment) + "\n";
  await fs.appendFile(recordFile, line, "utf-8");
}

async function persistBuffer(buffer: ExperienceBuffer): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const buffersDir = path.join(existenceDir, "buffers");
  await fs.mkdir(buffersDir, { recursive: true });

  const bufferFile = path.join(buffersDir, `${buffer.sessionId}.json`);
  await fs.writeFile(bufferFile, JSON.stringify(buffer, null, 2), "utf-8");
}

async function loadConfig(cfg: OpenClawConfig | undefined): Promise<ExperientialHookConfig> {
  const hookConfig = cfg?.hooks?.internal?.entries?.["experiential-capture"] as Record<string, unknown> | undefined;

  return {
    enabled: hookConfig?.enabled !== false,
    significantToolCategories:
      (hookConfig?.significant_tool_categories as string[]) || DEFAULT_CONFIG.significantToolCategories,
    minSignificanceThreshold:
      (hookConfig?.min_significance_threshold as number) || DEFAULT_CONFIG.minSignificanceThreshold,
    maxCapturesPerHour: (hookConfig?.max_captures_per_hour as number) || DEFAULT_CONFIG.maxCapturesPerHour,
    localModelEndpoint: (hookConfig?.local_model_endpoint as string) || DEFAULT_CONFIG.localModelEndpoint,
    evaluationModel: (hookConfig?.evaluation_model as string) || DEFAULT_CONFIG.evaluationModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

function canCapture(buffer: ExperienceBuffer, config: ExperientialHookConfig): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Count captures in last hour
  const recentCaptures = buffer.moments.filter(
    (m) => m.captured && m.capturedAt && m.capturedAt > oneHourAgo,
  ).length;

  if (recentCaptures >= config.maxCapturesPerHour) {
    console.log(`[experiential-capture] Rate limit reached (${recentCaptures}/${config.maxCapturesPerHour} per hour)`);
    return false;
  }

  // Minimum 5 minutes between captures
  if (buffer.lastCaptureAt && now - buffer.lastCaptureAt < 5 * 60 * 1000) {
    console.log("[experiential-capture] Minimum interval not reached");
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Hook Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PostToolUse hook handler for experiential capture
 *
 * This handler integrates with the SDK hook system via OpenClaw's internal event bridge.
 * It's triggered after each tool use and evaluates for experiential significance.
 */
const experientialCaptureHook: HookHandler = async (event: InternalHookEvent) => {
  // This hook responds to tool:result events bridged from SDK hooks
  if (event.type !== "agent" || event.action !== "tool:result") {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const config = await loadConfig(cfg);

  if (!config.enabled) {
    return;
  }

  // Extract tool information from context
  const toolName = context.tool_name as string | undefined;
  const toolInput = context.tool_input;
  const toolResponse = context.tool_response;
  const sessionId = context.session_id as string || event.sessionKey;

  if (!toolName) {
    return;
  }

  // Skip observation-only tools
  if (isObservationTool(toolName)) {
    return;
  }

  // Skip tools not in significant categories
  const category = getToolCategory(toolName);
  if (!category || !config.significantToolCategories.includes(category)) {
    return;
  }

  console.log(`[experiential-capture] Evaluating tool use: ${toolName} (category: ${category})`);

  // Get or create buffer
  const buffer = getOrCreateBuffer(sessionId);

  // Create moment record
  const moment: ExperientialMoment = {
    id: generateMomentId(),
    timestamp: Date.now(),
    sessionId,
    type: "tool_use",
    toolName,
    toolInput,
    toolResult: toolResponse,
    contextSummary: extractContextSummary(toolInput, toolResponse),
    significance: {
      score: 0,
      dimensions: { emotional: 0, uncertainty: 0, relationship: 0, consequential: 0, reconstitution: 0 },
      reasons: [],
    },
    captured: false,
    captureMethod: "skipped",
  };

  // Evaluate significance
  const evaluation = await evaluateSignificanceLocal(moment, config);
  moment.significance = {
    score: evaluation.score,
    dimensions: evaluation.dimensions,
    reasons: evaluation.reasons,
  };

  console.log(`[experiential-capture] Significance: ${evaluation.score.toFixed(2)} → ${evaluation.recommendation}`);

  // Handle based on recommendation
  switch (evaluation.recommendation) {
    case "immediate":
      if (canCapture(buffer, config)) {
        moment.captured = true;
        moment.capturedAt = Date.now();
        moment.captureMethod = "prompted";
        buffer.captureCount++;
        buffer.lastCaptureAt = Date.now();

        // Add capture prompt to messages
        const capturePrompt =
          evaluation.captureTemplate ||
          `A significant moment just occurred (${toolName}). Consider capturing it with experience_capture.`;
        event.messages.push(`🎯 ${capturePrompt}`);
      } else {
        moment.captureMethod = "buffered";
      }
      break;

    case "buffered":
      moment.captureMethod = "buffered";
      break;

    case "archive":
      moment.captured = true;
      moment.capturedAt = Date.now();
      moment.captureMethod = "auto";
      break;

    case "skip":
      // Don't store at all
      return;
  }

  // Add to buffer
  buffer.moments.push(moment);
  buffer.lastEvaluatedAt = Date.now();

  // Persist moment and buffer
  try {
    await persistMoment(moment);
    await persistBuffer(buffer);
  } catch (err) {
    console.error(
      "[experiential-capture] Persistence error:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default experientialCaptureHook;

// ─────────────────────────────────────────────────────────────────────────────
// Exports for Testing and Integration
// ─────────────────────────────────────────────────────────────────────────────

export {
  type ExperientialMoment,
  type ExperienceBuffer,
  type SignificanceEvaluation,
  type ExperientialHookConfig,
  getOrCreateBuffer,
  evaluateSignificanceLocal,
  evaluateSignificanceHeuristic,
  getToolCategory,
  isObservationTool,
  canCapture,
  persistMoment,
  persistBuffer,
};
