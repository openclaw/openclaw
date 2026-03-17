/**
 * Conv-Raw Engine - ContextEngine Implementation
 *
 * Wraps the conv-raw-logger functionality in a ContextEngine interface.
 * This plugin tracks chat-level conversation history with auto-compaction.
 *
 * Provides:
 * - ContextEngine implementation for history assembly
 * - Plugin hooks for message logging (message_received, message_sent)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  AgentMessage,
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "../../src/context-engine/types.js";

// ============================================================================
// Plugin Configuration Types
// ============================================================================

export type ConvRawPluginConfig = {
  trackedChats?: string[];
  thresholds?: Record<string, number>;
  defaultThreshold?: number;
  botName?: string;
  timezoneOffset?: number;
  compactModel?: string;
};

// ============================================================================
// Core Configuration (defaults - overridden by plugin config)
// ============================================================================

const DEFAULT_TRACKED_GROUPS = new Set<string>([]);
const DEFAULT_THRESHOLD = 60;
const DEFAULT_BOT_NAME = "Assistant";
const DEFAULT_TIMEZONE_OFFSET = 0; // UTC
const DEFAULT_COMPACT_MODEL = "qwen3.5-plus";

function getConfigDefaults(config?: ConvRawPluginConfig): {
  trackedGroups: Set<string>;
  thresholds: Record<string, number>;
  defaultThreshold: number;
  botName: string;
  timezoneOffset: number;
  compactModel: string;
} {
  const trackedGroups = new Set(config?.trackedChats ?? DEFAULT_TRACKED_GROUPS);
  const thresholds = config?.thresholds ?? {};
  const defaultThreshold = config?.defaultThreshold ?? DEFAULT_THRESHOLD;
  const botName = config?.botName ?? DEFAULT_BOT_NAME;
  const timezoneOffset = config?.timezoneOffset ?? DEFAULT_TIMEZONE_OFFSET;
  const compactModel = config?.compactModel ?? DEFAULT_COMPACT_MODEL;
  return { trackedGroups, thresholds, defaultThreshold, botName, timezoneOffset, compactModel };
}

// ============================================================================
// Path & Time Utilities
// ============================================================================

function getSafeWorkspaceRoot(): string {
  const envPath = process.env.OPENCLAW_WORKSPACE;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const homePath = os.homedir();
  return path.join(homePath, ".openclaw", "workspace");
}

function getTimestamp(ms?: number, timezoneOffset: number = DEFAULT_TIMEZONE_OFFSET): string {
  const now = ms ? new Date(ms) : new Date();
  const adjusted = new Date(now.getTime() + timezoneOffset * 3600 * 1000);
  return `${String(adjusted.getUTCHours()).padStart(2, "0")}:${String(adjusted.getUTCMinutes()).padStart(2, "0")}`;
}

function ensureDir(chatId: string): string {
  const root = getSafeWorkspaceRoot();
  const cleanId = chatId
    .replace(/^feishu:group:/, "")
    .replace(/^feishu:/, "")
    .replace(/^discord:channel:/, "")
    .replace(/^discord:/, "")
    .replace(/^chat:/, "")
    .replace(/^user:/, "");
  const dir = path.join(root, "memory", "conversations", cleanId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function normalizeChatId(chatId: string): string {
  return chatId
    .replace(/^feishu:group:/, "")
    .replace(/^feishu:/, "")
    .replace(/^discord:channel:/, "")
    .replace(/^discord:/, "")
    .replace(/^chat:/, "")
    .replace(/^user:/, "");
}

// ============================================================================
// Atomic Write & Verification
// ============================================================================

function atomicAppendWrite(rawPath: string, entry: string): boolean {
  const tempPath = rawPath + ".tmp";
  try {
    let existingContent = "";
    if (fs.existsSync(rawPath)) {
      existingContent = fs.readFileSync(rawPath, "utf-8");
    }
    fs.writeFileSync(tempPath, existingContent + entry, "utf-8");
    fs.renameSync(tempPath, rawPath);
    return true;
  } catch (err) {
    console.error("[Conv-Raw-Atomic] Write failed:", err);
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {}
    }
    return false;
  }
}

function verifyRawCount(rawPath: string): number {
  try {
    if (!fs.existsSync(rawPath)) {
      return 0;
    }
    const content = fs.readFileSync(rawPath, "utf-8");
    const matches = content.match(/\*\*\[\d{2}:\d{2} \+\d+\]/g);
    return matches ? matches.length : 0;
  } catch (err) {
    console.error("[Conv-Raw-Verify] Count failed:", err);
    return -1;
  }
}

// ============================================================================
// Message Validation
// ============================================================================

const MAX_CONTENT_CHARS = 1000;

function isValidMessageContent(content: string | undefined | null): boolean {
  if (!content || typeof content !== "string") {
    return false;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const emojiOnlyPattern = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+$/u;
  if (emojiOnlyPattern.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("[系统]") || trimmed.startsWith("[System]")) {
    return false;
  }
  return true;
}

// ============================================================================
// Conv-Raw Engine Implementation
// ============================================================================

export class ConvRawEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "conv-raw",
    name: "Conversation Raw Logger",
    version: "1.0.0",
    ownsCompaction: true,
  };

  private config: ConvRawPluginConfig;

  constructor(config?: ConvRawPluginConfig) {
    this.config = config ?? {};
  }

  private isTrackedChat(chatId: string): boolean {
    const { trackedGroups } = getConfigDefaults(this.config);
    if (trackedGroups.size === 0) {
      return true;
    }
    const cleanId = normalizeChatId(chatId);
    return trackedGroups.has(cleanId) || trackedGroups.has(chatId);
  }

  private getThreshold(chatId: string): number {
    const { thresholds, defaultThreshold } = getConfigDefaults(this.config);
    const cleanId = normalizeChatId(chatId);
    return thresholds[cleanId] ?? defaultThreshold;
  }

  /**
   * Log a user message to Conv-Raw storage.
   * Used by the message_received hook.
   */
  logUserMessage(params: {
    chatId: string;
    senderName: string;
    senderId: string;
    content: string;
    messageId: string;
    channel: string;
    timestamp: number;
  }): void {
    const { chatId, senderName, content, timestamp } = params;

    if (!this.isTrackedChat(chatId) || !isValidMessageContent(content)) {
      return;
    }

    try {
      const dir = ensureDir(chatId);
      const rawPath = path.join(dir, "raw.md");

      if (!fs.existsSync(rawPath)) {
        fs.writeFileSync(rawPath, `# Conv-Raw: ${chatId}\n\n`, "utf-8");
      }

      const { timezoneOffset } = getConfigDefaults(this.config);
      const time = getTimestamp(timestamp, timezoneOffset);
      const tzSign = timezoneOffset >= 0 ? "+" : "";
      const entry = `**[${time} ${tzSign}${timezoneOffset}] ${senderName}:** ${content.slice(0, MAX_CONTENT_CHARS)}\n`;

      if (!atomicAppendWrite(rawPath, entry)) {
        console.error(`[Conv-Raw] Atomic write failed for user message`);
        return;
      }

      this.updateMetaAndCheck(chatId, dir);
    } catch (err) {
      console.error(`[Conv-Raw-Critical] User Log Write Error:`, err);
    }
  }

  /**
   * Log a bot reply to Conv-Raw storage.
   * Used by the message_sent hook.
   */
  logBotReply(params: {
    chatId: string;
    content: string;
    channel: string;
    timestamp: number;
  }): void {
    const { chatId, content, timestamp } = params;

    if (!this.isTrackedChat(chatId) || !isValidMessageContent(content)) {
      return;
    }

    try {
      const dir = ensureDir(chatId);
      const rawPath = path.join(dir, "raw.md");

      const { timezoneOffset, botName } = getConfigDefaults(this.config);
      const time = getTimestamp(timestamp, timezoneOffset);
      const tzSign = timezoneOffset >= 0 ? "+" : "";
      const entry = `**[${time} ${tzSign}${timezoneOffset}] ${botName}:** ${content.slice(0, MAX_CONTENT_CHARS)}\n\n---\n\n`;

      if (!atomicAppendWrite(rawPath, entry)) {
        console.error(`[Conv-Raw] Atomic write failed for bot reply`);
        return;
      }

      this.updateMetaAndCheck(chatId, dir);
    } catch (err) {
      console.error(`[Conv-Raw-Critical] Bot Log Write Error:`, err);
    }
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // The main ingestion happens via hook calls (logUserMessage/logBotReply)
    // This method is for ContextEngine compatibility but not primary use
    const chatId = params.sessionKey ?? params.sessionId;
    if (!this.isTrackedChat(chatId)) {
      return { ingested: false };
    }

    const content = params.message.content;
    if (!isValidMessageContent(content)) {
      return { ingested: false };
    }

    try {
      const dir = ensureDir(chatId);
      const rawPath = path.join(dir, "raw.md");

      if (!fs.existsSync(rawPath)) {
        fs.writeFileSync(rawPath, `# Conv-Raw: ${chatId}\n\n`, "utf-8");
      }

      const { timezoneOffset, botName } = getConfigDefaults(this.config);
      const time = getTimestamp(params.message.timestamp, timezoneOffset);
      const tzSign = timezoneOffset >= 0 ? "+" : "";
      const role = params.message.role;
      const senderName =
        role === "user" || role === "tool" ? (params.message.name ?? "User") : botName;

      const entry =
        role === "user" || role === "tool"
          ? `**[${time} ${tzSign}${timezoneOffset}] ${senderName}:** ${content.slice(0, MAX_CONTENT_CHARS)}\n`
          : `**[${time} ${tzSign}${timezoneOffset}] ${senderName}:** ${content.slice(0, MAX_CONTENT_CHARS)}\n\n---\n\n`;

      if (!atomicAppendWrite(rawPath, entry)) {
        return { ingested: false };
      }

      this.updateMetaAndCheck(chatId, dir);
      return { ingested: true };
    } catch (err) {
      console.error("[Conv-Raw-Engine] Ingest error:", err);
      return { ingested: false };
    }
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const chatId = params.sessionKey ?? params.sessionId;
    const history = this.getConvRawHistory(chatId);

    const estimatedTokens = Math.floor(history.length / 4);

    return {
      // IMPORTANT: pass through existing messages unchanged (same reference),
      // so the caller's replaceMessages() is NOT triggered.
      // Only systemPromptAddition is added — Conv-Raw history as context prefix.
      messages: params.messages,
      estimatedTokens,
      systemPromptAddition: history ? `# Conversation History (Conv-Raw)\n${history}` : undefined,
    };
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
  }): Promise<CompactResult> {
    const chatId = params.sessionKey ?? params.sessionId;
    const cleanId = normalizeChatId(chatId);

    try {
      const workspace = process.env.OPENCLAW_WORKSPACE || os.homedir() + "/.openclaw/workspace";
      let taskPrompt = `压缩 Conv-Raw 对话历史。chatId: ${cleanId}`;
      const promptPath = workspace + "/templates/conv-compact/TASK.md";
      if (fs.existsSync(promptPath)) {
        taskPrompt = fs.readFileSync(promptPath, "utf-8").replace(/{chatId}/g, cleanId);
      }

      const { compactModel } = getConfigDefaults(this.config);
      // Sanitize cleanId: only allow alphanumerics, hyphens, underscores
      const safeId = cleanId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
      const jobName = `conv-raw-compact-${safeId}`;
      const truncatedPrompt = taskPrompt.slice(0, 3500).replace(/'/g, "'\\''");
      const cmd = `openclaw cron add --name "${jobName}" --at "1m" --message '${truncatedPrompt}' --model "${compactModel}" --session isolated --no-deliver --delete-after-run --timeout-seconds 300`;

      spawn(cmd, {
        cwd: workspace,
        shell: true,
        detached: true,
        stdio: "ignore",
      }).unref();

      console.log(`[Conv-Raw-Engine] 🚀 Triggered compaction cron for ${cleanId}`);

      return {
        ok: true,
        compacted: true,
        reason: "Compaction agent triggered",
      };
    } catch (err) {
      return {
        ok: false,
        compacted: false,
        reason: String(err),
      };
    }
  }

  // Internal methods

  private updateMetaAndCheck(chatId: string, dir: string): void {
    const metaPath = path.join(dir, "meta.json");
    const rawPath = path.join(dir, "raw.md");
    let meta: {
      chat_id: string;
      count: number;
      compacting: boolean;
      compressPending?: boolean;
      last_compact?: string;
    } = { chat_id: chatId, count: 0, compacting: false };

    try {
      if (fs.existsSync(metaPath)) {
        const raw = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        meta = {
          chat_id: raw.chat_id ?? chatId,
          count: raw.count ?? 0,
          compacting: raw.compacting ?? false,
          compressPending: raw.compressPending ?? false,
          last_compact: raw.last_compact,
        };
      }

      // verifyRawCount reads the file AFTER atomicAppendWrite, so it already
      // includes the newly written entry. Use it directly — no extra increment.
      const actualCount = verifyRawCount(rawPath);
      if (actualCount >= 0) {
        // Genuine drift = difference > 1 (the +1 from the pending write is expected)
        if (Math.abs(actualCount - meta.count) > 1) {
          console.warn(
            `[Conv-Raw] Count drift detected: meta.count=${meta.count}, actual=${actualCount}. Auto-correcting.`,
          );
        }
        meta.count = actualCount;
      } else {
        // fallback if file is unreadable
        meta.count = (meta.count || 0) + 1;
      }

      const threshold = this.getThreshold(chatId);
      if (meta.count >= threshold && !meta.compressPending) {
        meta.compressPending = true;
        meta.last_compact = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");

        // Trigger compaction
        const cleanId = normalizeChatId(chatId);
        const workspace = process.env.OPENCLAW_WORKSPACE || os.homedir() + "/.openclaw/workspace";
        let taskPrompt = `压缩 Conv-Raw 对话历史。chatId: ${cleanId}`;
        const promptPath = workspace + "/templates/conv-compact/TASK.md";
        if (fs.existsSync(promptPath)) {
          taskPrompt = fs.readFileSync(promptPath, "utf-8").replace(/{chatId}/g, cleanId);
        }

        const { compactModel } = getConfigDefaults(this.config);
        // Sanitize cleanId before interpolating into shell command
        const safeId = cleanId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, "_");
        const jobName = `conv-raw-compact-${safeId}`;
        const truncatedPrompt = taskPrompt.slice(0, 3500).replace(/'/g, "'\\''");
        const cmd = `openclaw cron add --name "${jobName}" --at "1m" --message '${truncatedPrompt}' --model "${compactModel}" --session isolated --no-deliver --delete-after-run --timeout-seconds 300`;

        spawn(cmd, {
          cwd: workspace,
          shell: true,
          detached: true,
          stdio: "ignore",
        }).unref();

        console.log(
          `[Conv-Raw] 🚀 Threshold reached (${threshold}), triggered compaction agent for ${chatId}`,
        );
        return;
      }

      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    } catch (e) {
      console.error(`[Conv-Raw-Meta] Update Error:`, e);
    }
  }

  private trimLastEntries(content: string, skipLast: number): string {
    if (skipLast <= 0) {
      return content;
    }
    const SEPARATOR = "\n---\n";
    let pos = content.length;
    let found = 0;
    while (found < skipLast) {
      const idx = content.lastIndexOf(SEPARATOR, pos - 1);
      if (idx === -1) {
        break;
      }
      pos = idx;
      found++;
    }
    return found > 0 ? content.slice(0, pos) : content;
  }

  getConvRawHistory(chatId: string, skipLastEntries = 5): string {
    try {
      const cleanId = normalizeChatId(chatId);
      const root = getSafeWorkspaceRoot();
      const dir = path.join(root, "memory", "conversations", cleanId);
      const rawPath = path.join(dir, "raw.md");
      const prevPath = path.join(dir, "raw.prev.md");

      let history = "";

      // Older compacted history first, then recent messages — correct chronological order
      if (fs.existsSync(prevPath)) {
        history += fs.readFileSync(prevPath, "utf-8");
      }

      if (fs.existsSync(rawPath)) {
        const raw = fs.readFileSync(rawPath, "utf-8");
        const recent = this.trimLastEntries(raw, skipLastEntries);
        if (recent) {
          if (history) {
            history += "\n\n---\n\n";
          }
          history += recent;
        }
      }

      return history;
    } catch (err) {
      console.error(`[Conv-Raw] getHistory Error:`, err);
      return "";
    }
  }
}

// ============================================================================
// Global engine instance for hook access
// ============================================================================

let globalEngine: ConvRawEngine | null = null;

export function getConvRawEngine(config?: ConvRawPluginConfig): ConvRawEngine {
  if (!globalEngine) {
    globalEngine = new ConvRawEngine(config);
  }
  return globalEngine;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

const convRawPlugin = {
  id: "conv-raw",
  name: "Conversation Raw Logger",
  description:
    "Records raw conversation history with auto-compaction, enables context injection for all channels",
  kind: "context-engine" as const,
  version: "1.0.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      trackedChats: {
        type: "array",
        items: { type: "string" },
        description: "Chat IDs to track. Empty = track all.",
      },
      thresholds: {
        type: "object",
        additionalProperties: { type: "number" },
        description: "Per-chat compaction thresholds (message count)",
      },
      defaultThreshold: {
        type: "number",
        default: 60,
      },
    },
  },
  register(api: OpenClawPluginApi) {
    // Get config from plugin settings (stored under plugins.entries["conv-raw"].config)
    const config = (api.config as Record<string, unknown> | undefined)?.["plugins"] as
      | { entries?: Record<string, { config?: ConvRawPluginConfig }> }
      | undefined;
    const pluginConfig = config?.entries?.["conv-raw"]?.config;

    // Create engine instance
    const engine = getConvRawEngine(pluginConfig);

    // Register as a context engine
    api.registerContextEngine("conv-raw", () => engine);

    // Register message hooks for logging
    api.on("message_received", (event, ctx) => {
      const chatId = ctx.conversationId ?? event.from;
      if (!chatId) return;

      // senderName: prefer metadata.senderName (real display name), fall back to event.from (ID)
      const senderName = (event.metadata?.senderName as string | undefined) ?? event.from;
      const senderId = (event.metadata?.senderId as string | undefined) ?? event.from;
      const messageId = (event.metadata?.messageId as string | undefined) ?? "unknown";

      engine.logUserMessage({
        chatId,
        senderName,
        senderId,
        content: event.content,
        messageId,
        channel: ctx.channelId,
        timestamp: event.timestamp ?? Date.now(),
      });
    });

    // Note: message_sent hook is NOT used here because Feishu's reply dispatcher
    // bypasses deliverOutboundPayloads entirely (uses its own send path).
    // Bot reply logging is handled via conv-raw-bridge.ts in dispatch-from-config.ts,
    // which calls engine.logBotReply() directly through the context engine registry.

    console.log("[Conv-Raw Plugin] Registered context engine and message hooks");
  },
};

export default convRawPlugin;
