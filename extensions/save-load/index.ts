import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ─── Runtime Reference ───────────────────────────────────────────────────────

let _runtime: PluginRuntime | null = null;

// ─── Constants ───────────────────────────────────────────────────────────────

const SAVES_DIR = path.join(os.homedir(), ".openclaw", "saves");
const BOUNDARY_STATE_FILE = path.join(SAVES_DIR, ".boundary-state.json");

function sessionsDir(agentName: string = "main"): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentName, "sessions");
}

function sessionsStorePath(agentName: string = "main"): string {
  return path.join(sessionsDir(agentName), "sessions.json");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function escapeLabel(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

// ─── Session Resolution ──────────────────────────────────────────────────────

type SessionEntry = {
  sessionId: string;
  sessionFile?: string;
  [key: string]: unknown;
};

function loadSessionStore(): Record<string, SessionEntry> {
  const storePath = sessionsStorePath();
  if (!fs.existsSync(storePath)) return {};
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

function saveSessionStore(store: Record<string, SessionEntry>) {
  fs.writeFileSync(sessionsStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Resolve the session key for the current chat context.
 * For DMs, the canonical key is "agent:main:main".
 * For groups, we search by channel/from patterns.
 */
function resolveSessionKey(channel: string, from?: string): string | null {
  const store = loadSessionStore();

  // Direct message: canonical key
  if (store["agent:main:main"]) {
    return "agent:main:main";
  }

  // Fallback: search by channel prefix
  const channelPrefix = `agent:main:${channel}:`;
  for (const key of Object.keys(store)) {
    if (key.startsWith(channelPrefix)) {
      return key;
    }
  }

  // Last resort: find any "main" key
  for (const key of Object.keys(store)) {
    if (key.endsWith(":main")) {
      return key;
    }
  }

  return null;
}

function resolveTranscriptPath(sessionId: string, sessionFile?: string): string {
  if (sessionFile && fs.existsSync(sessionFile)) {
    return sessionFile;
  }
  return path.join(sessionsDir(), `${sessionId}.jsonl`);
}

// ─── Transcript Parsing ──────────────────────────────────────────────────────

type TranscriptMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

type JsonlEntry = {
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text: string }>;
  };
  [key: string]: unknown;
};

function extractTextContent(content: string | Array<{ type: string; text: string }>): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function parseTranscript(filePath: string): JsonlEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e): e is JsonlEntry => e !== null);
}

function filterMessages(entries: JsonlEntry[], afterTimestamp?: string): TranscriptMessage[] {
  return entries
    .filter((e) => e.type === "message" && e.message)
    .filter((e) => {
      const role = e.message!.role;
      return role === "user" || role === "assistant";
    })
    .filter((e) => {
      if (!afterTimestamp) return true;
      return (e.timestamp ?? "") >= afterTimestamp;
    })
    .map((e) => ({
      role: e.message!.role as "user" | "assistant",
      content: extractTextContent(e.message!.content),
      timestamp: e.timestamp,
    }))
    .filter((m) => m.content.trim().length > 0);
}

// ─── Boundary State ──────────────────────────────────────────────────────────

type BoundaryState = {
  lastBoundary: string;
  lastAction: string;
  updatedAt: string;
};

function loadBoundaryState(): BoundaryState | null {
  if (!fs.existsSync(BOUNDARY_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(BOUNDARY_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveBoundaryState(boundary: string, action: string) {
  ensureDir(SAVES_DIR);
  fs.writeFileSync(
    BOUNDARY_STATE_FILE,
    JSON.stringify(
      {
        lastBoundary: boundary,
        lastAction: action,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

// ─── Save Index ──────────────────────────────────────────────────────────────

type SaveIndexEntry = {
  filename: string;
  label: string;
  savedAt: string;
  messageCount: number;
};

function indexPath(): string {
  return path.join(SAVES_DIR, "index.json");
}

function loadSaveIndex(): SaveIndexEntry[] {
  const p = indexPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function updateSaveIndex(entry: SaveIndexEntry) {
  const index = loadSaveIndex();
  // Remove existing entry with same filename
  const filtered = index.filter((e) => e.filename !== entry.filename);
  filtered.unshift(entry);
  fs.writeFileSync(indexPath(), JSON.stringify(filtered, null, 2), "utf-8");
}

function removeFromSaveIndex(filename: string) {
  const index = loadSaveIndex().filter((e) => e.filename !== filename);
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), "utf-8");
}

// ─── Session Reset (for /load) ───────────────────────────────────────────────

function generateSessionId(): string {
  return crypto.randomUUID();
}

function archiveTranscript(sessionId: string) {
  const transcriptPath = path.join(sessionsDir(), `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return;
  const archiveName = `${sessionId}.reset.${Date.now()}.jsonl`;
  const archivePath = path.join(sessionsDir(), archiveName);
  fs.renameSync(transcriptPath, archivePath);
}

/**
 * Build a JSONL transcript from saved messages.
 * Includes session header, then user/assistant messages alternating.
 */
function buildTranscript(sessionId: string, messages: TranscriptMessage[]): string {
  const lines: object[] = [];

  // Session header
  lines.push({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });

  let prevMsgId: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgId = crypto.randomBytes(4).toString("hex");

    lines.push({
      type: "message",
      id: msgId,
      parentId: prevMsgId,
      timestamp: new Date(Date.now() + i).toISOString(),
      message: {
        role: msg.role,
        content: [{ type: "text", text: msg.content }],
      },
    });

    prevMsgId = msgId;
  }

  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ─── Command Handlers ────────────────────────────────────────────────────────

function handleSave(args?: string, ctx?: { channel?: string; from?: string }): { text: string } {
  ensureDir(SAVES_DIR);

  // Resolve current session
  if (!ctx?.channel) {
    return { text: "⚠️ Could not determine channel context." };
  }
  const sessionKey = resolveSessionKey(ctx.channel, ctx.from);
  if (!sessionKey) {
    return { text: "⚠️ Could not resolve current session." };
  }

  const store = loadSessionStore();
  const entry = store[sessionKey];
  if (!entry) {
    return { text: "⚠️ No active session found." };
  }

  const transcriptPath = resolveTranscriptPath(entry.sessionId, entry.sessionFile);
  if (!fs.existsSync(transcriptPath)) {
    return { text: "⚠️ Transcript file not found." };
  }

  // Parse transcript and filter from boundary
  const allEntries = parseTranscript(transcriptPath);
  const boundaryState = loadBoundaryState();
  const afterTimestamp = boundaryState?.lastBoundary;
  const messages = filterMessages(allEntries, afterTimestamp);

  if (messages.length === 0) {
    return { text: "⚠️ No messages to save since last boundary." };
  }

  // Parse flags: /save --append <label> or /save --new <label>
  let rawLabel = args || "unnamed";
  let appendMode = false;
  let forceNew = false;

  if (args?.startsWith("--append ")) {
    appendMode = true;
    rawLabel = args.slice("--append ".length).trim() || "unnamed";
  } else if (args?.startsWith("--new ")) {
    forceNew = true;
    rawLabel = args.slice("--new ".length).trim() || "unnamed";
  }

  const label = escapeLabel(rawLabel);
  const index = loadSaveIndex();
  const existingEntry = index.find(
    (e) => (e.label.toLowerCase() === rawLabel.toLowerCase()) || e.filename.includes(`_${label}.`),
  );

  // If same-name exists and no flag given, ask user
  if (existingEntry && !appendMode && !forceNew) {
    const existingPath = path.join(SAVES_DIR, existingEntry.filename);
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      const existingCount = existing.messageCount || existing.messages?.length || 0;
      return {
        text: [
          `⚠️ 存档 **${rawLabel}** 已存在（${existingCount} 条消息）。`,
          ``,
          `请选择：`,
          `• \`/save --append ${rawLabel}\` — 追加新消息到末尾`,
          `• \`/save --new ${rawLabel}\` — 创建新的独立存档`,
        ].join("\n"),
      };
    }
  }

  // Append mode: merge new messages into existing save
  if (existingEntry && appendMode) {
    const existingPath = path.join(SAVES_DIR, existingEntry.filename);
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      const existingMessages: TranscriptMessage[] = existing.messages || [];

      // Deduplicate: only add messages not already in the save (by content)
      const existingContents = new Set(existingMessages.map((m) => m.content));
      const newMessages = messages.filter((m) => !existingContents.has(m.content));

      if (newMessages.length === 0) {
        return { text: `ℹ️ 没有新消息可以追加到 **${rawLabel}**。` };
      }

      const mergedMessages = [...existingMessages, ...newMessages];
      existing.messages = mergedMessages;
      existing.messageCount = mergedMessages.length;
      existing.savedAt = new Date().toISOString();

      fs.writeFileSync(existingPath, JSON.stringify(existing, null, 2), "utf-8");

      // Update index
      updateSaveIndex({
        filename: existingEntry.filename,
        label: rawLabel,
        savedAt: existing.savedAt,
        messageCount: mergedMessages.length,
      });

      // Update boundary
      const now = new Date().toISOString();
      saveBoundaryState(now, `save:${existingEntry.filename}`);

      return {
        text: [
          `✅ 已追加 ${newMessages.length} 条新消息到 **${rawLabel}**`,
          `📁 ${existingEntry.filename}`,
          `📊 总计：${mergedMessages.length} 条消息`,
          ``,
          `使用 /load ${label} 恢复上下文。`,
        ].join("\n"),
      };
    }
  }

  // New save mode
  const ts = timestamp();
  const filename = `${ts}_${label}.json`;
  const filePath = path.join(SAVES_DIR, filename);

  // Write save file
  const saveData = {
    version: 1,
    label: args || "unnamed",
    savedAt: new Date().toISOString(),
    messageCount: messages.length,
    sourceSession: sessionKey,
    messages,
  };
  fs.writeFileSync(filePath, JSON.stringify(saveData, null, 2), "utf-8");

  // Update boundary
  const now = new Date().toISOString();
  saveBoundaryState(now, `save:${filename}`);

  // Update index
  updateSaveIndex({
    filename,
    label: args || "unnamed",
    savedAt: saveData.savedAt,
    messageCount: messages.length,
  });

  return {
    text: [
      `✅ Saved ${messages.length} messages`,
      `📁 ${filename}`,
      `🏷️ Label: ${args || "unnamed"}`,
      ``,
      `Use /load ${label} to restore, or /load to list all saves.`,
    ].join("\n"),
  };
}

function handleList(): { text: string } {
  ensureDir(SAVES_DIR);
  const index = loadSaveIndex();

  if (index.length === 0) {
    return { text: "📭 No saved contexts. Use `/save <label>` to save one." };
  }

  const lines = ["📚 **Saved Contexts**\n"];
  index.forEach((entry, i) => {
    const date = new Date(entry.savedAt).toLocaleString();
    lines.push(`${i + 1}. **${entry.label}** — ${entry.messageCount} msgs, ${date}`);
    lines.push(`   File: \`${entry.filename}\``);
  });
  lines.push("\nUse `/load <label>` or `/load <number>` to load.");
  lines.push("Use `/load --delete <label>` to delete.");

  return { text: lines.join("\n") };
}

function handleLoad(args?: string, ctx?: { channel?: string; from?: string }): { text: string } {
  ensureDir(SAVES_DIR);

  if (!args || args.trim() === "") {
    return handleList();
  }

  // Handle --delete
  if (args.startsWith("--delete ")) {
    return handleDelete(args.slice("--delete ".length).trim());
  }

  // Find the save file
  const index = loadSaveIndex();
  let targetEntry: SaveIndexEntry | undefined;

  // Try by number first
  const num = parseInt(args, 10);
  if (!isNaN(num) && num >= 1 && num <= index.length) {
    targetEntry = index[num - 1];
  }

  // Try by label
  if (!targetEntry) {
    const normalized = args.toLowerCase().trim();
    targetEntry = index.find(
      (e) =>
        e.label.toLowerCase() === normalized ||
        e.label.toLowerCase().includes(normalized) ||
        e.filename.toLowerCase().includes(normalized),
    );
  }

  if (!targetEntry) {
    return { text: `⚠️ Save not found: "${args}". Use /load to list available saves.` };
  }

  const filePath = path.join(SAVES_DIR, targetEntry.filename);
  if (!fs.existsSync(filePath)) {
    return { text: `⚠️ Save file missing: ${targetEntry.filename}` };
  }

  // Read save data
  const saveData = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  if (!Array.isArray(saveData.messages)) {
    return { text: `⚠️ Save file is malformed or incompatible: ${targetEntry.filename}` };
  }
  const messages: TranscriptMessage[] = saveData.messages as TranscriptMessage[];

  // Resolve current session
  if (!ctx?.channel) {
    return { text: "⚠️ Could not determine channel context." };
  }
  const sessionKey = resolveSessionKey(ctx.channel, ctx.from);
  if (!sessionKey) {
    return { text: "⚠️ Could not resolve current session." };
  }

  const store = loadSessionStore();
  const currentEntry = store[sessionKey];
  if (!currentEntry) {
    return { text: "⚠️ No active session found." };
  }

  // Archive current transcript
  archiveTranscript(currentEntry.sessionId);

  // Create new session with loaded messages
  const newSessionId = generateSessionId();
  const newTranscriptPath = path.join(sessionsDir(), `${newSessionId}.jsonl`);
  const transcriptContent = buildTranscript(newSessionId, messages);
  fs.writeFileSync(newTranscriptPath, transcriptContent, "utf-8");

  // Update session store
  store[sessionKey] = {
    ...currentEntry,
    sessionId: newSessionId,
    sessionFile: newTranscriptPath,
    contextTokens: undefined,
    systemPromptReport: undefined,
  };
  saveSessionStore(store);

  // Update boundary
  const now = new Date().toISOString();
  saveBoundaryState(now, `load:${targetEntry.filename}`);

  // Build context summary for the agent
  const summaryLines = messages.slice(0, 10).map((m) => {
    const preview = m.content.slice(0, 120).replace(/\n/g, " ");
    return `[${m.role}] ${preview}${m.content.length > 120 ? "..." : ""}`;
  });
  if (messages.length > 10) {
    summaryLines.push(`... and ${messages.length - 10} more messages`);
  }

  const saveFilePath = filePath;

  // Inject system event so the running agent picks up the loaded context
  if (_runtime && sessionKey) {
    const systemEvent = [
      `[SYSTEM: Context Loaded]`,
      `A saved conversation context has been loaded:`,
      `- Label: ${targetEntry.label}`,
      `- Messages: ${messages.length}`,
      `- Save file: ${saveFilePath}`,
      ``,
      `Conversation summary:`,
      ...summaryLines,
      ``,
      `To restore full context, read the save file with the read tool:`,
      `\`read ${saveFilePath}\``,
      `Then continue the conversation naturally, as if you remember everything.`,
    ].join("\n");

    try {
      _runtime.system.enqueueSystemEvent(systemEvent, { sessionKey });
    } catch (e) {
      // Non-fatal: system event injection failed, context still saved to file
    }
  }

  return {
    text: [
      `✅ Loaded **${targetEntry.label}** (${messages.length} messages)`,
      `🆔 New session: \`${newSessionId.slice(0, 8)}\``,
      `📂 Save file: \`${saveFilePath}\``,
      ``,
      `Context injected. The agent will pick it up on the next turn.`,
    ].join("\n"),
  };
}

function handleDelete(name: string): { text: string } {
  const index = loadSaveIndex();
  let targetEntry: SaveIndexEntry | undefined;

  // Try by number
  const num = parseInt(name, 10);
  if (!isNaN(num) && num >= 1 && num <= index.length) {
    targetEntry = index[num - 1];
  }

  // Try by label
  if (!targetEntry) {
    const normalized = name.toLowerCase().trim();
    targetEntry = index.find(
      (e) =>
        e.label.toLowerCase() === normalized ||
        e.label.toLowerCase().includes(normalized) ||
        e.filename.toLowerCase().includes(normalized),
    );
  }

  if (!targetEntry) {
    return { text: `⚠️ Save not found: "${name}". Use /load to list available saves.` };
  }

  const filePath = path.join(SAVES_DIR, targetEntry.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  removeFromSaveIndex(targetEntry.filename);

  return { text: `🗑️ Deleted save: **${targetEntry.label}** (${targetEntry.filename})` };
}

// ─── Plugin Entry ────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "save-load",
  name: "Save/Load Context",
  description: "Save and load conversation context",
  register(api) {
    // Store runtime reference for system event injection
    _runtime = api.runtime;

    api.registerCommand({
      name: "save",
      description: "Save current conversation context to a file",
      acceptsArgs: true,
      handler: (ctx) => {
        return handleSave(ctx.args, { channel: ctx.channel, from: ctx.from });
      },
    });

    api.registerCommand({
      name: "load",
      description: "Load a saved conversation context (or list/delete saves)",
      acceptsArgs: true,
      handler: (ctx) => {
        if (!ctx.args) {
          return handleList();
        }
        return handleLoad(ctx.args, { channel: ctx.channel, from: ctx.from });
      },
    });
  },
});
