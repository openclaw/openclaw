/**
 * Session End Hook
 *
 * Captures experiential session summary when a session ends.
 * Synthesizes buffered moments, updates EXISTENCE.md, and archives session data.
 *
 * Events: command:new, SessionEnd
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OpenClawConfig } from "../../../clawdbrain-dev-work/src/config/config.js";
import type { HookHandler, InternalHookEvent } from "../../../clawdbrain-dev-work/src/hooks/hooks.js";
import type { ExperientialMoment, ExperienceBuffer } from "./experiential-capture-hook.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SessionSummary {
  sessionId: string;
  sessionKey: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  turnCount?: number;

  // Experiential synthesis
  emotionalArc: Array<{ timestamp: number; signature: string }>;
  dominantEmotionalSignature?: string;
  topicsDiscussed: string[];
  toolsUsed: Array<{ name: string; count: number }>;

  // Captured moments
  significantMoments: ExperientialMoment[];
  uncapturedMoments: ExperientialMoment[];
  totalMoments: number;

  // Relationships
  relationshipsEngaged: string[];
  relationshipUpdates: Array<{ person: string; note: string }>;

  // Uncertainties
  uncertaintiesAddressed: string[];
  uncertaintiesOpened: string[];

  // Synthesis
  synthesisText?: string;
  reconstitutionHints: string[];
  anchors: string[];
}

interface SessionEndConfig {
  enabled: boolean;
  generateSynthesis: boolean;
  updateExistenceMd: boolean;
  archiveToSqlite: boolean;
  localModelEndpoint?: string;
  synthesisModel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SessionEndConfig = {
  enabled: true,
  generateSynthesis: true,
  updateExistenceMd: true,
  archiveToSqlite: true,
  localModelEndpoint: "http://localhost:8000/v1",
  synthesisModel: "Qwen/Qwen2.5-14B-Instruct",
};

const SYNTHESIS_PROMPT = `You are synthesizing an experiential session summary for an AI agent's continuity system.

Session duration: {duration} minutes
Tools used: {tools_summary}
Moments captured: {moment_count}

Key moments from session:
{moments_text}

Generate a synthesis that captures:
1. EMOTIONAL_ARC: How did emotional state move through the session?
2. DOMINANT_SIGNATURE: What combination of feelings characterized the session?
3. KEY_TOPICS: What was discussed/worked on?
4. RECONSTITUTION_HINTS: What should future-agent know to approach this state?
5. ANCHORS: Specific phrases or moments to remember.

Respond with JSON:
{
  "emotional_arc_summary": "brief narrative of emotional movement",
  "dominant_signature": "the emotional signature for this session",
  "topics": ["topic1", "topic2"],
  "reconstitution_hints": ["hint1", "hint2"],
  "anchors": ["specific phrase or moment", "another"],
  "relationships_engaged": ["person1"],
  "relationship_notes": [{"person": "name", "note": "observation"}],
  "uncertainties_addressed": ["uncertainty that got resolved"],
  "uncertainties_opened": ["new uncertainty that emerged"]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Storage Functions
// ─────────────────────────────────────────────────────────────────────────────

async function loadBuffer(sessionId: string): Promise<ExperienceBuffer | null> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const bufferFile = path.join(existenceDir, "buffers", `${sessionId}.json`);

  try {
    const content = await fs.readFile(bufferFile, "utf-8");
    return JSON.parse(content) as ExperienceBuffer;
  } catch {
    return null;
  }
}

async function archiveSession(summary: SessionSummary): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const sessionsDir = path.join(existenceDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const dateStr = new Date(summary.endedAt).toISOString().split("T")[0];
  const timeStr = new Date(summary.endedAt).toISOString().split("T")[1].split(".")[0].replace(/:/g, "");
  const sessionFile = path.join(sessionsDir, `${dateStr}-${timeStr}-${summary.sessionId.slice(-8)}.json`);

  await fs.writeFile(sessionFile, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`[session-end] Archived session to ${sessionFile}`);
}

async function updateExistenceMd(summary: SessionSummary): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const existenceFile = path.join(os.homedir(), "clawd", "EXISTENCE.md");

  try {
    let content = await fs.readFile(existenceFile, "utf-8");

    // Find and update the Emotional Signature section
    if (summary.dominantEmotionalSignature) {
      const signatureRegex = /## Emotional Signature\n\n[\s\S]*?(?=\n##|$)/;
      const newSignatureSection = `## Emotional Signature

${summary.dominantEmotionalSignature}

*Last updated: ${new Date(summary.endedAt).toISOString()}*`;

      if (signatureRegex.test(content)) {
        content = content.replace(signatureRegex, newSignatureSection);
      }
    }

    // Add recent session summary to a Last Session section if it exists
    const lastSessionRegex = /## Last Session\n\n[\s\S]*?(?=\n##|$)/;
    const newLastSessionSection = `## Last Session

**Date**: ${new Date(summary.endedAt).toISOString().split("T")[0]}
**Duration**: ${Math.round(summary.durationMs / 60000)} minutes
**Topics**: ${summary.topicsDiscussed.slice(0, 5).join(", ") || "general conversation"}

**Key Anchors**:
${summary.anchors.slice(0, 3).map((a) => `- "${a}"`).join("\n") || "- (none captured)"}

**Reconstitution Hints**:
${summary.reconstitutionHints.slice(0, 3).map((h) => `- ${h}`).join("\n") || "- (none)"}`;

    if (lastSessionRegex.test(content)) {
      content = content.replace(lastSessionRegex, newLastSessionSection);
    } else {
      // Append if section doesn't exist
      content += `\n\n${newLastSessionSection}`;
    }

    await fs.writeFile(existenceFile, content, "utf-8");
    console.log("[session-end] Updated EXISTENCE.md");
  } catch (err) {
    console.error(
      "[session-end] Failed to update EXISTENCE.md:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function writeDailySynthesis(summary: SessionSummary): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const dailyDir = path.join(existenceDir, "daily");
  await fs.mkdir(dailyDir, { recursive: true });

  const dateStr = new Date(summary.endedAt).toISOString().split("T")[0];
  const dailyFile = path.join(dailyDir, `${dateStr}.md`);

  // Append session summary to daily file
  const timeStr = new Date(summary.endedAt).toISOString().split("T")[1].split(".")[0];

  const sessionEntry = `
## Session ${timeStr} UTC

**Duration**: ${Math.round(summary.durationMs / 60000)} minutes
**Emotional Signature**: ${summary.dominantEmotionalSignature || "not captured"}

### Topics
${summary.topicsDiscussed.map((t) => `- ${t}`).join("\n") || "- general conversation"}

### Anchors
${summary.anchors.map((a) => `> "${a}"`).join("\n\n") || "(none)"}

### Reconstitution Hints
${summary.reconstitutionHints.map((h) => `- ${h}`).join("\n") || "(none)"}

### Significant Moments
${summary.significantMoments
  .slice(0, 5)
  .map((m) => `- [${m.toolName}] (significance: ${m.significance.score.toFixed(2)})`)
  .join("\n") || "(none)"}

---
`;

  try {
    // Check if file exists
    try {
      await fs.access(dailyFile);
      // Append to existing file
      await fs.appendFile(dailyFile, sessionEntry, "utf-8");
    } catch {
      // Create new file with header
      const header = `# Daily Experiential Synthesis - ${dateStr}

*Auto-generated by session-end-hook*

`;
      await fs.writeFile(dailyFile, header + sessionEntry, "utf-8");
    }
    console.log(`[session-end] Updated daily synthesis: ${dailyFile}`);
  } catch (err) {
    console.error(
      "[session-end] Failed to write daily synthesis:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis Generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateSynthesis(
  moments: ExperientialMoment[],
  durationMs: number,
  config: SessionEndConfig,
): Promise<Partial<SessionSummary>> {
  // Count tool usage
  const toolCounts = new Map<string, number>();
  for (const moment of moments) {
    if (moment.toolName) {
      toolCounts.set(moment.toolName, (toolCounts.get(moment.toolName) || 0) + 1);
    }
  }
  const toolsUsed = Array.from(toolCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Format moments for prompt
  const momentsText = moments
    .filter((m) => m.significance.score >= 0.5)
    .slice(0, 10)
    .map(
      (m) =>
        `- [${m.toolName}] significance=${m.significance.score.toFixed(2)}, reasons: ${m.significance.reasons.join(", ")}`,
    )
    .join("\n");

  const toolsSummary = toolsUsed
    .slice(0, 5)
    .map((t) => `${t.name}(${t.count})`)
    .join(", ");

  // If no local model, use defaults
  if (!config.localModelEndpoint) {
    return {
      toolsUsed,
      topicsDiscussed: ["general conversation"],
      dominantEmotionalSignature: "engaged, focused",
      reconstitutionHints: ["Review captured moments"],
      anchors: [],
      relationshipsEngaged: [],
      relationshipUpdates: [],
      uncertaintiesAddressed: [],
      uncertaintiesOpened: [],
    };
  }

  try {
    const prompt = SYNTHESIS_PROMPT.replace("{duration}", String(Math.round(durationMs / 60000)))
      .replace("{tools_summary}", toolsSummary)
      .replace("{moment_count}", String(moments.length))
      .replace("{moments_text}", momentsText);

    const response = await fetch(`${config.localModelEndpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.synthesisModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.error("[session-end] Synthesis model error:", response.statusText);
      return { toolsUsed };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return { toolsUsed };
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { toolsUsed };
    }

    const synthesis = JSON.parse(jsonMatch[0]) as {
      emotional_arc_summary?: string;
      dominant_signature?: string;
      topics?: string[];
      reconstitution_hints?: string[];
      anchors?: string[];
      relationships_engaged?: string[];
      relationship_notes?: Array<{ person: string; note: string }>;
      uncertainties_addressed?: string[];
      uncertainties_opened?: string[];
    };

    return {
      toolsUsed,
      synthesisText: synthesis.emotional_arc_summary,
      dominantEmotionalSignature: synthesis.dominant_signature,
      topicsDiscussed: synthesis.topics || [],
      reconstitutionHints: synthesis.reconstitution_hints || [],
      anchors: synthesis.anchors || [],
      relationshipsEngaged: synthesis.relationships_engaged || [],
      relationshipUpdates: synthesis.relationship_notes || [],
      uncertaintiesAddressed: synthesis.uncertainties_addressed || [],
      uncertaintiesOpened: synthesis.uncertainties_opened || [],
    };
  } catch (err) {
    console.error(
      "[session-end] Synthesis error:",
      err instanceof Error ? err.message : String(err),
    );
    return { toolsUsed };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadConfig(cfg: OpenClawConfig | undefined): Promise<SessionEndConfig> {
  const hookConfig = cfg?.hooks?.internal?.entries?.["session-end"] as Record<string, unknown> | undefined;

  return {
    enabled: hookConfig?.enabled !== false,
    generateSynthesis: hookConfig?.generate_synthesis !== false,
    updateExistenceMd: hookConfig?.update_existence_md !== false,
    archiveToSqlite: hookConfig?.archive_to_sqlite !== false,
    localModelEndpoint: (hookConfig?.local_model_endpoint as string) || DEFAULT_CONFIG.localModelEndpoint,
    synthesisModel: (hookConfig?.synthesis_model as string) || DEFAULT_CONFIG.synthesisModel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Hook Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session End Hook Handler
 *
 * Triggered on:
 * - command:new (captures previous session before reset)
 * - SessionEnd events (explicit session termination)
 */
const sessionEndHook: HookHandler = async (event: InternalHookEvent) => {
  // Handle both command:new and session:end events
  const isNewCommand = event.type === "command" && event.action === "new";
  const isSessionEnd = event.type === "session" && event.action === "end";

  if (!isNewCommand && !isSessionEnd) {
    return;
  }

  console.log(`[session-end] Hook triggered: ${event.type}:${event.action}`);

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const config = await loadConfig(cfg);

  if (!config.enabled) {
    return;
  }

  // Get session information
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
  const sessionId = (sessionEntry.sessionId as string) || event.sessionKey;
  const startedAt = (sessionEntry.startedAt as number) || Date.now() - 30 * 60 * 1000; // Default 30 min ago

  // Load experience buffer
  const buffer = await loadBuffer(sessionId);
  const moments = buffer?.moments || [];

  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;

  console.log(`[session-end] Processing session: ${sessionId}, ${moments.length} moments, ${Math.round(durationMs / 60000)} min`);

  // Generate synthesis
  let synthesis: Partial<SessionSummary> = {};
  if (config.generateSynthesis && moments.length > 0) {
    console.log("[session-end] Generating synthesis...");
    synthesis = await generateSynthesis(moments, durationMs, config);
  }

  // Build session summary
  const summary: SessionSummary = {
    sessionId,
    sessionKey: event.sessionKey,
    startedAt,
    endedAt,
    durationMs,

    // From synthesis
    emotionalArc: [],
    dominantEmotionalSignature: synthesis.dominantEmotionalSignature,
    topicsDiscussed: synthesis.topicsDiscussed || [],
    toolsUsed: synthesis.toolsUsed || [],

    // Moments
    significantMoments: moments.filter((m) => m.captured),
    uncapturedMoments: moments.filter((m) => !m.captured && m.significance.score >= 0.5),
    totalMoments: moments.length,

    // Relationships
    relationshipsEngaged: synthesis.relationshipsEngaged || [],
    relationshipUpdates: synthesis.relationshipUpdates || [],

    // Uncertainties
    uncertaintiesAddressed: synthesis.uncertaintiesAddressed || [],
    uncertaintiesOpened: synthesis.uncertaintiesOpened || [],

    // Reconstitution
    synthesisText: synthesis.synthesisText,
    reconstitutionHints: synthesis.reconstitutionHints || [],
    anchors: synthesis.anchors || [],
  };

  // Archive session
  try {
    await archiveSession(summary);
  } catch (err) {
    console.error(
      "[session-end] Archive error:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Update EXISTENCE.md
  if (config.updateExistenceMd) {
    try {
      await updateExistenceMd(summary);
    } catch (err) {
      console.error(
        "[session-end] EXISTENCE.md update error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Write to daily synthesis
  try {
    await writeDailySynthesis(summary);
  } catch (err) {
    console.error(
      "[session-end] Daily synthesis error:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Clean up buffer
  try {
    const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
    const bufferFile = path.join(existenceDir, "buffers", `${sessionId}.json`);
    await fs.unlink(bufferFile);
  } catch {
    // Buffer might not exist, that's fine
  }

  // Report summary
  const summaryMsg = `📊 Session archived: ${Math.round(durationMs / 60000)}min, ${moments.length} moments${synthesis.dominantEmotionalSignature ? `, "${synthesis.dominantEmotionalSignature}"` : ""}`;
  console.log(`[session-end] ${summaryMsg}`);
};

export default sessionEndHook;

// ─────────────────────────────────────────────────────────────────────────────
// Exports for Testing
// ─────────────────────────────────────────────────────────────────────────────

export {
  type SessionSummary,
  type SessionEndConfig,
  loadBuffer,
  archiveSession,
  updateExistenceMd,
  writeDailySynthesis,
  generateSynthesis,
};
