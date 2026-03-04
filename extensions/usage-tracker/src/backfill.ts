/**
 * Backfill engine: scan historical session transcripts and generate past JSONL data.
 * Uses stream parsing (readline) for memory efficiency.
 * Computes duration by matching toolCall → toolResult timestamp pairs.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { classifyReadPath } from "./classifier.js";
import { extractSkillSessions, type TranscriptEntry } from "./skill-session.js";
import type {
  SkillSessionRecord,
  SkillSessionStorage,
  UsageRecord,
  UsageStorage,
} from "./storage.js";

type PendingToolCall = {
  toolName: string;
  toolCallId: string;
  params?: Record<string, unknown>;
  timestamp?: number; // ms epoch
  entryTimestamp?: string; // ISO string
};

/**
 * Parse a timestamp from a transcript entry.
 * Returns millisecond epoch or undefined.
 */
function parseTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  // entry.timestamp is ISO string (e.g. "2026-03-03T17:41:32.008Z")
  if (typeof entry.timestamp === "string") {
    const parsed = new Date(entry.timestamp);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.getTime();
    }
  }
  // message.timestamp is ms epoch
  if (typeof message.timestamp === "number" && message.timestamp > 1_000_000_000_000) {
    return message.timestamp;
  }
  if (typeof message.timestamp === "number" && message.timestamp > 1_000_000_000) {
    return message.timestamp * 1000;
  }
  return undefined;
}

/**
 * Backfill a single session transcript file.
 * Matches toolCall entries with their toolResult entries to compute duration.
 */
async function backfillSessionFile(
  filePath: string,
  sessionId: string,
  agentId: string,
): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const pendingCalls = new Map<string, PendingToolCall>();

  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type !== "message") continue;
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") continue;

      const role = message.role as string;
      const tsMs = parseTimestamp(entry, message);

      // Handle assistant messages with tool calls
      if (role === "assistant") {
        const content = message.content;
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const type = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";

          if (type === "tool_use" || type === "toolcall" || type === "tool_call") {
            const name = typeof b.name === "string" ? b.name.trim() : undefined;
            const id = typeof b.id === "string" ? b.id : undefined;
            if (!name) continue;

            // Transcript uses "arguments" for tool call params
            const args = (b.arguments ?? b.input) as Record<string, unknown> | undefined;

            if (id) {
              pendingCalls.set(id, {
                toolName: name,
                toolCallId: id,
                params: args ?? undefined,
                timestamp: tsMs,
                entryTimestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
              });
            } else {
              // No id — emit immediately without duration
              const tsSec = tsMs ? Math.floor(tsMs / 1000) : Math.floor(Date.now() / 1000);
              const record: UsageRecord = {
                ts: tsSec,
                tool: name,
                session: sessionId,
                agent: agentId,
              };
              classifyAndAttach(record, name, args);
              records.push(record);
            }
          }
        }
      }

      // Handle tool results — match with pending calls to compute duration
      if (role === "toolResult" || role === "tool") {
        const toolCallId = (message.toolCallId ?? message.tool_call_id) as string | undefined;
        if (!toolCallId) continue;

        const pending = pendingCalls.get(toolCallId);
        if (!pending) continue;
        pendingCalls.delete(toolCallId);

        const callTs = pending.timestamp;
        const resultTs = tsMs;
        const durationMs = callTs && resultTs ? Math.max(0, resultTs - callTs) : undefined;
        const tsSec = callTs ? Math.floor(callTs / 1000) : Math.floor(Date.now() / 1000);

        const isError = message.isError === true;
        const record: UsageRecord = {
          ts: tsSec,
          tool: pending.toolName,
          session: sessionId,
          agent: agentId,
          dur: durationMs,
        };

        if (isError) {
          const content = message.content;
          let errMsg = "";
          if (typeof content === "string") {
            errMsg = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (
                typeof block === "object" &&
                block &&
                typeof (block as Record<string, unknown>).text === "string"
              ) {
                errMsg = (block as Record<string, unknown>).text as string;
                break;
              }
            }
          }
          if (errMsg) {
            record.err = errMsg.slice(0, 200);
          }
        }

        classifyAndAttach(record, pending.toolName, pending.params);
        records.push(record);
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  // Flush any remaining pending calls (tool calls without matching results)
  for (const pending of pendingCalls.values()) {
    const tsSec = pending.timestamp
      ? Math.floor(pending.timestamp / 1000)
      : Math.floor(Date.now() / 1000);
    const record: UsageRecord = {
      ts: tsSec,
      tool: pending.toolName,
      session: sessionId,
      agent: agentId,
    };
    classifyAndAttach(record, pending.toolName, pending.params);
    records.push(record);
  }

  return records;
}

function classifyAndAttach(
  record: UsageRecord,
  toolName: string,
  params?: Record<string, unknown>,
): void {
  if (toolName === "read" || toolName === "Read") {
    const filePath =
      typeof params?.file_path === "string"
        ? params.file_path
        : typeof params?.path === "string"
          ? params.path
          : undefined;

    if (filePath) {
      record.path = filePath;
      const classification = classifyReadPath(filePath);
      if (classification.isSkill) {
        record.skill = classification.skill;
        record.skillType = classification.skillType;
      }
    }
  }
}

export type BackfillResult = {
  sessionsScanned: number;
  recordsGenerated: number;
  errors: string[];
};

/**
 * Run backfill across all session transcripts for a given agent.
 * Clears existing data and regenerates from scratch.
 */
export async function runBackfill(params: {
  sessionsDir: string;
  agentId: string;
  storage: UsageStorage;
  logger: PluginLogger;
  clear?: boolean;
}): Promise<BackfillResult> {
  const { sessionsDir, agentId, storage, logger } = params;
  const result: BackfillResult = { sessionsScanned: 0, recordsGenerated: 0, errors: [] };

  if (params.clear !== false) {
    storage.clear();
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    result.errors.push(`Cannot read sessions directory: ${sessionsDir}`);
    return result;
  }

  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
  logger.info(`usage-tracker: backfilling ${files.length} session files`);

  for (const file of files) {
    const fp = path.join(sessionsDir, file.name);
    const sid = file.name.slice(0, -6); // strip .jsonl

    try {
      const records = await backfillSessionFile(fp, sid, agentId);
      if (records.length > 0) {
        storage.appendBatch(records);
        result.recordsGenerated += records.length;
      }
      result.sessionsScanned += 1;
    } catch (err) {
      const msg = `Failed to backfill ${file.name}: ${String(err)}`;
      logger.error(`usage-tracker: ${msg}`);
      result.errors.push(msg);
    }
  }

  logger.info(
    `usage-tracker: backfill complete — ${result.sessionsScanned} sessions, ${result.recordsGenerated} records`,
  );
  return result;
}

// ── Skill Session extraction during backfill ──────────────────────────

/**
 * Extract transcript entries suitable for skill session analysis from a session file.
 */
async function extractTranscriptEntries(filePath: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl2 = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl2) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (raw.type !== "message") continue;
      const message = raw.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const role = message.role as string;
      // Parse timestamp
      let tsMs = 0;
      if (typeof raw.timestamp === "string") {
        const d = new Date(raw.timestamp as string);
        if (!Number.isNaN(d.valueOf())) tsMs = d.getTime();
      }
      if (!tsMs && typeof message.timestamp === "number") {
        tsMs =
          (message.timestamp as number) > 1e12
            ? (message.timestamp as number)
            : (message.timestamp as number) * 1000;
      }

      const toolCalls: Array<{ name: string; path?: string }> = [];
      let hasTextResponse = false;
      let skillEntry: string | undefined;
      let skillSubRead: string | undefined;

      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          const btype = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";

          if (btype === "tool_use" || btype === "toolcall" || btype === "tool_call") {
            const name = typeof b.name === "string" ? b.name.trim() : "";
            if (!name) continue;
            const args = (b.arguments ?? b.input) as Record<string, unknown> | undefined;
            const p =
              typeof args?.file_path === "string"
                ? args.file_path
                : typeof args?.path === "string"
                  ? args.path
                  : undefined;
            toolCalls.push({ name, path: p });

            // Classify for skill detection
            if ((name === "read" || name === "Read") && p) {
              const cls = classifyReadPath(p);
              if (cls.isSkill) {
                if (cls.skillType === "entry") {
                  skillEntry = cls.skill;
                } else {
                  skillSubRead = cls.skill;
                }
              }
            }
          } else if (btype === "text" && typeof b.text === "string" && b.text.length > 30) {
            hasTextResponse = true;
          }
        }
      } else if (typeof content === "string" && content.length > 30) {
        hasTextResponse = true;
      }

      // Text response = assistant with text but no tool calls
      if (role !== "assistant") {
        hasTextResponse = false;
      }

      entries.push({
        tsMs,
        role,
        toolCalls,
        hasTextResponse: hasTextResponse && toolCalls.length === 0,
        skillEntry,
        skillSubRead,
      });
    }
  } finally {
    rl2.close();
    fileStream.destroy();
  }

  return entries;
}

/**
 * Backfill skill sessions from all session transcripts.
 */
export async function backfillSkillSessions(params: {
  sessionsDir: string;
  agentId: string;
  skillSessionStorage: SkillSessionStorage;
  logger: PluginLogger;
}): Promise<{ sessionsScanned: number; skillSessionsFound: number }> {
  const { sessionsDir, agentId, skillSessionStorage, logger } = params;
  skillSessionStorage.clear();

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return { sessionsScanned: 0, skillSessionsFound: 0 };
  }

  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
  let totalSkillSessions = 0;

  for (const file of files) {
    const fp = path.join(sessionsDir, file.name);
    const sid = file.name.slice(0, -6);

    try {
      const transcriptEntries = await extractTranscriptEntries(fp);
      const skillSessions = extractSkillSessions(transcriptEntries);

      if (skillSessions.length > 0) {
        const records: SkillSessionRecord[] = skillSessions.map((s) => ({
          ...s,
          session: sid,
          agent: agentId,
        }));
        skillSessionStorage.appendBatch(records);
        totalSkillSessions += skillSessions.length;
      }
    } catch (err) {
      logger.error(`usage-tracker: skill session backfill error for ${file.name}: ${String(err)}`);
    }
  }

  logger.info(
    `usage-tracker: skill session backfill — ${totalSkillSessions} sessions from ${files.length} files`,
  );
  return { sessionsScanned: files.length, skillSessionsFound: totalSkillSessions };
}
