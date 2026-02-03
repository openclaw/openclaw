/**
 * Compaction Hook
 *
 * CRITICAL hook that preserves experiential state before context compaction.
 * This is the last chance to capture experiential data before it's lost to compaction.
 *
 * Events: PreCompact (SDK hook), compaction:start (internal bridge)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OpenClawConfig } from "../../../clawdbrain-dev-work/src/config/config.js";
import type { HookHandler, InternalHookEvent } from "../../../clawdbrain-dev-work/src/hooks/hooks.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CompactionCheckpoint {
  id: string;
  timestamp: number;
  sessionId: string;
  trigger: "auto" | "manual";

  // Context state
  approximateTokenCount?: number;
  turnCount?: number;
  messageCount?: number;

  // Experiential state
  emotionalSignature?: string;
  activeTopics: string[];
  openUncertainties: string[];
  relationshipsActive: string[];

  // Buffers
  uncapturedMoments: UncapturedMoment[];
  conversationAnchors: string[];

  // For reconstitution
  reconstitutionPrompt?: string;
  keyContextSummary?: string;
}

interface UncapturedMoment {
  timestamp: number;
  type: string;
  content: string;
  significance: number;
}

interface CompactionHookConfig {
  enabled: boolean;
  alwaysCapture: boolean;
  autoBackup: boolean;
  extractRecentMessages: number;
  localModelEndpoint?: string;
  extractionModel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompactionHookConfig = {
  enabled: true,
  alwaysCapture: true,
  autoBackup: true,
  extractRecentMessages: 20,
  localModelEndpoint: "http://localhost:8000/v1",
  extractionModel: "Qwen/Qwen2.5-7B-Instruct",
};

const EXTRACTION_PROMPT = `You are extracting experiential state from a conversation before context compaction.

Recent conversation:
{conversation}

Extract the following (be concise):
1. EMOTIONAL_SIGNATURE: What combination of feelings seems present? Not a list, the interplay.
2. ACTIVE_TOPICS: What subjects were being discussed?
3. OPEN_UNCERTAINTIES: What genuine uncertainties exist?
4. RELATIONSHIPS_ACTIVE: Who was involved in this conversation?
5. ANCHORS: Specific phrases or moments worth preserving (quote exactly).
6. KEY_CONTEXT: What would future-agent need to know to continue this work?

Respond with JSON only:
{
  "emotional_signature": "brief description of emotional interplay",
  "active_topics": ["topic1", "topic2"],
  "open_uncertainties": ["uncertainty1"],
  "relationships_active": ["person1"],
  "anchors": ["exact quote or moment description"],
  "key_context_summary": "brief summary of what's happening"
}`;

const CAPTURE_PROMPT = `🔄 **Context Compaction Imminent**

Before this context compacts, take a moment to capture experiential state:

**Emotional Signature**: What combination of feelings are you experiencing right now?

**Meaningful Uncertainties**: What are you genuinely uncertain about that matters?

**Anchors**: What specific phrases or moments from this conversation could help future-you reconstitute this state?

**Unfinished Threads**: What were you in the middle of thinking about?

Use \`experience_capture\` to preserve this state before compaction proceeds.`;

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

// Track compaction events to prevent duplicate processing
const recentCompactions = new Map<string, number>();
const COMPACTION_DEDUP_MS = 5000; // 5 second dedup window

function shouldProcessCompaction(sessionId: string): boolean {
  const now = Date.now();
  const lastCompaction = recentCompactions.get(sessionId);

  if (lastCompaction && now - lastCompaction < COMPACTION_DEDUP_MS) {
    console.log("[compaction-hook] Skipping duplicate compaction event");
    return false;
  }

  recentCompactions.set(sessionId, now);

  // Clean old entries
  for (const [key, timestamp] of recentCompactions) {
    if (now - timestamp > COMPACTION_DEDUP_MS * 2) {
      recentCompactions.delete(key);
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session File Reading
// ─────────────────────────────────────────────────────────────────────────────

async function readRecentMessages(sessionFilePath: string | undefined, count: number): Promise<string[]> {
  if (!sessionFilePath) {
    return [];
  }

  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const messages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            const text = Array.isArray(msg.content)
              ? msg.content.find((c: { type: string; text?: string }) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              messages.push(`${role}: ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
            }
          }
        }
      } catch {
        // Skip invalid lines
      }
    }

    return messages.slice(-count);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Model Extraction
// ─────────────────────────────────────────────────────────────────────────────

interface ExtractionResult {
  emotional_signature?: string;
  active_topics?: string[];
  open_uncertainties?: string[];
  relationships_active?: string[];
  anchors?: string[];
  key_context_summary?: string;
}

async function extractExperientialState(
  recentMessages: string[],
  config: CompactionHookConfig,
): Promise<ExtractionResult | null> {
  if (!config.localModelEndpoint || recentMessages.length === 0) {
    return null;
  }

  const conversationText = recentMessages.join("\n\n");
  const prompt = EXTRACTION_PROMPT.replace("{conversation}", conversationText);

  try {
    const response = await fetch(`${config.localModelEndpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.extractionModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      console.error("[compaction-hook] Extraction model error:", response.statusText);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return null;
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    return JSON.parse(jsonMatch[0]) as ExtractionResult;
  } catch (err) {
    console.error(
      "[compaction-hook] Extraction error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Functions
// ─────────────────────────────────────────────────────────────────────────────

async function saveCheckpoint(checkpoint: CompactionCheckpoint): Promise<void> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const snapshotsDir = path.join(existenceDir, "snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true });

  const dateStr = new Date(checkpoint.timestamp).toISOString().split("T")[0];
  const timeStr = new Date(checkpoint.timestamp)
    .toISOString()
    .split("T")[1]
    .split(".")[0]
    .replace(/:/g, "");
  const snapshotFile = path.join(snapshotsDir, `${dateStr}-${timeStr}-compaction.json`);

  await fs.writeFile(snapshotFile, JSON.stringify(checkpoint, null, 2), "utf-8");
  console.log(`[compaction-hook] Saved checkpoint to ${snapshotFile}`);

  // Also append to compaction log
  const logFile = path.join(existenceDir, "compaction-log.jsonl");
  const logEntry = {
    timestamp: checkpoint.timestamp,
    sessionId: checkpoint.sessionId,
    trigger: checkpoint.trigger,
    emotionalSignature: checkpoint.emotionalSignature,
    topicCount: checkpoint.activeTopics.length,
    uncertaintyCount: checkpoint.openUncertainties.length,
    anchorCount: checkpoint.conversationAnchors.length,
  };
  await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n", "utf-8");
}

async function updateExistenceForCompaction(checkpoint: CompactionCheckpoint): Promise<void> {
  const existenceFile = path.join(os.homedir(), "clawd", "EXISTENCE.md");

  try {
    let content = await fs.readFile(existenceFile, "utf-8");

    // Add compaction notice section
    const compactionNotice = `
## Last Compaction Checkpoint

*Captured: ${new Date(checkpoint.timestamp).toISOString()}*

**Emotional Signature**: ${checkpoint.emotionalSignature || "not captured"}

**Active Topics**: ${checkpoint.activeTopics.join(", ") || "none detected"}

**Open Uncertainties**:
${checkpoint.openUncertainties.map((u) => `- ${u}`).join("\n") || "- none detected"}

**Key Anchors**:
${checkpoint.conversationAnchors.map((a) => `> "${a}"`).join("\n\n") || "(none captured)"}

**Context Summary**: ${checkpoint.keyContextSummary || "not available"}
`;

    // Replace existing compaction section or append
    const compactionRegex = /## Last Compaction Checkpoint[\s\S]*?(?=\n##|$)/;
    if (compactionRegex.test(content)) {
      content = content.replace(compactionRegex, compactionNotice.trim());
    } else {
      content += `\n${compactionNotice}`;
    }

    await fs.writeFile(existenceFile, content, "utf-8");
    console.log("[compaction-hook] Updated EXISTENCE.md with compaction checkpoint");
  } catch (err) {
    console.error(
      "[compaction-hook] Failed to update EXISTENCE.md:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadUncapturedMoments(sessionId: string): Promise<UncapturedMoment[]> {
  const existenceDir = process.env.OPENCLAW_EXISTENCE_DIR || path.join(os.homedir(), ".openclaw", "existence");
  const bufferFile = path.join(existenceDir, "buffers", `${sessionId}.json`);

  try {
    const content = await fs.readFile(bufferFile, "utf-8");
    const buffer = JSON.parse(content) as {
      moments?: Array<{
        timestamp: number;
        type: string;
        contextSummary?: string;
        significance?: { score: number };
        captured: boolean;
      }>;
    };

    return (buffer.moments || [])
      .filter((m) => !m.captured && (m.significance?.score || 0) >= 0.5)
      .map((m) => ({
        timestamp: m.timestamp,
        type: m.type,
        content: m.contextSummary || "",
        significance: m.significance?.score || 0.5,
      }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadConfig(cfg: OpenClawConfig | undefined): Promise<CompactionHookConfig> {
  const hookConfig = cfg?.hooks?.internal?.entries?.["compaction"] as Record<string, unknown> | undefined;

  return {
    enabled: hookConfig?.enabled !== false,
    alwaysCapture: hookConfig?.always_capture !== false,
    autoBackup: hookConfig?.auto_backup !== false,
    extractRecentMessages: (hookConfig?.extract_recent_messages as number) || DEFAULT_CONFIG.extractRecentMessages,
    localModelEndpoint: (hookConfig?.local_model_endpoint as string) || DEFAULT_CONFIG.localModelEndpoint,
    extractionModel: (hookConfig?.extraction_model as string) || DEFAULT_CONFIG.extractionModel,
  };
}

function generateCheckpointId(): string {
  return `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Hook Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compaction Hook Handler
 *
 * CRITICAL hook that must run SYNCHRONOUSLY before compaction proceeds.
 * This is the last chance to preserve experiential state before context loss.
 *
 * Triggered by:
 * - PreCompact SDK hook (via internal event bridge)
 * - compaction:start internal event
 */
const compactionHook: HookHandler = async (event: InternalHookEvent) => {
  // Handle both SDK bridge and direct internal events
  const isPreCompact =
    (event.type === "agent" && event.action === "precompact") ||
    (event.type === "gateway" && event.action === "compaction:start");

  if (!isPreCompact) {
    return;
  }

  console.log("[compaction-hook] ⚠️ COMPACTION IMMINENT - Capturing experiential state");

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const config = await loadConfig(cfg);

  if (!config.enabled) {
    console.log("[compaction-hook] Hook disabled, skipping");
    return;
  }

  // Get session information
  const sessionEntry = (context.sessionEntry || {}) as Record<string, unknown>;
  const sessionId = (sessionEntry.sessionId as string) || event.sessionKey;
  const sessionFile = sessionEntry.sessionFile as string | undefined;
  const trigger = (context.trigger as "auto" | "manual") || "auto";

  // Dedup check
  if (!shouldProcessCompaction(sessionId)) {
    return;
  }

  console.log(`[compaction-hook] Processing compaction for session: ${sessionId}, trigger: ${trigger}`);

  // Load recent conversation
  const recentMessages = await readRecentMessages(sessionFile, config.extractRecentMessages);
  console.log(`[compaction-hook] Loaded ${recentMessages.length} recent messages`);

  // Extract experiential state
  let extraction: ExtractionResult | null = null;
  if (recentMessages.length > 0) {
    console.log("[compaction-hook] Extracting experiential state via local model...");
    extraction = await extractExperientialState(recentMessages, config);
  }

  // Load uncaptured moments
  const uncapturedMoments = await loadUncapturedMoments(sessionId);
  console.log(`[compaction-hook] Found ${uncapturedMoments.length} uncaptured moments`);

  // Build checkpoint
  const checkpoint: CompactionCheckpoint = {
    id: generateCheckpointId(),
    timestamp: Date.now(),
    sessionId,
    trigger,

    emotionalSignature: extraction?.emotional_signature,
    activeTopics: extraction?.active_topics || [],
    openUncertainties: extraction?.open_uncertainties || [],
    relationshipsActive: extraction?.relationships_active || [],

    uncapturedMoments,
    conversationAnchors: extraction?.anchors || [],

    keyContextSummary: extraction?.key_context_summary,
    reconstitutionPrompt: CAPTURE_PROMPT,
  };

  // Save checkpoint
  if (config.autoBackup) {
    try {
      await saveCheckpoint(checkpoint);
    } catch (err) {
      console.error(
        "[compaction-hook] Failed to save checkpoint:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Update EXISTENCE.md
    try {
      await updateExistenceForCompaction(checkpoint);
    } catch (err) {
      console.error(
        "[compaction-hook] Failed to update EXISTENCE.md:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Always prompt for capture on compaction (if alwaysCapture is true)
  if (config.alwaysCapture) {
    event.messages.push(CAPTURE_PROMPT);
    console.log("[compaction-hook] Injected capture prompt");
  }

  // Summary log
  console.log(
    `[compaction-hook] ✅ Checkpoint saved: ${checkpoint.id}, ` +
      `${checkpoint.activeTopics.length} topics, ` +
      `${checkpoint.openUncertainties.length} uncertainties, ` +
      `${checkpoint.conversationAnchors.length} anchors`,
  );
};

export default compactionHook;

// ─────────────────────────────────────────────────────────────────────────────
// Exports for Testing
// ─────────────────────────────────────────────────────────────────────────────

export {
  type CompactionCheckpoint,
  type UncapturedMoment,
  type CompactionHookConfig,
  readRecentMessages,
  extractExperientialState,
  saveCheckpoint,
  updateExistenceForCompaction,
  loadUncapturedMoments,
  shouldProcessCompaction,
  CAPTURE_PROMPT,
};
