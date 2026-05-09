import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";
import { normalizeIMessageCatchupCursor } from "./monitor/catchup.js";

const IMESSAGE_PLUGIN_ID = "imessage";
const REPLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SENT_ECHO_TTL_MS = 2 * 60 * 1000;

type ReplyCacheEntry = {
  accountId: string;
  messageId: string;
  shortId: string;
  timestamp: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  isFromMe?: boolean;
};

type SentEchoEntry = {
  scope: string;
  text?: string;
  messageId?: string;
  timestamp: number;
};

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hasJsonFiles(dirPath: string): boolean {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function imessageDir(stateDir: string): string {
  return path.join(stateDir, "imessage");
}

function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}

function replyCacheEntryKey(messageId: string): string {
  return hashKey(messageId);
}

function sentEchoEntryKey(entry: SentEchoEntry): string {
  return hashKey(
    `${entry.scope}\0${entry.text ?? ""}\0${entry.messageId ?? ""}\0${entry.timestamp}`,
  );
}

function parseJsonl<T>(
  sourcePath: string,
  normalize: (parsed: unknown) => T | null,
): { entries: T[]; skipped: number } {
  const entries: T[] = [];
  let skipped = 0;
  const raw = fs.readFileSync(sourcePath, "utf8");
  for (const line of raw.split(/\n+/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = normalize(JSON.parse(line) as unknown);
      if (entry) {
        entries.push(entry);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

function normalizeReplyCacheEntry(value: unknown): ReplyCacheEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<ReplyCacheEntry>;
  if (
    typeof entry.accountId !== "string" ||
    typeof entry.messageId !== "string" ||
    typeof entry.shortId !== "string" ||
    typeof entry.timestamp !== "number"
  ) {
    return null;
  }
  return {
    accountId: entry.accountId,
    messageId: entry.messageId,
    shortId: entry.shortId,
    timestamp: entry.timestamp,
    ...(typeof entry.chatGuid === "string" ? { chatGuid: entry.chatGuid } : {}),
    ...(typeof entry.chatIdentifier === "string" ? { chatIdentifier: entry.chatIdentifier } : {}),
    ...(typeof entry.chatId === "number" ? { chatId: entry.chatId } : {}),
    ...(typeof entry.isFromMe === "boolean" ? { isFromMe: entry.isFromMe } : {}),
  };
}

function normalizeSentEchoEntry(value: unknown): SentEchoEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Partial<SentEchoEntry>;
  if (typeof entry.scope !== "string" || typeof entry.timestamp !== "number") {
    return null;
  }
  const text = typeof entry.text === "string" && entry.text.trim() ? entry.text : undefined;
  const messageId =
    typeof entry.messageId === "string" && entry.messageId.trim() ? entry.messageId : undefined;
  if (!text && !messageId) {
    return null;
  }
  return {
    scope: entry.scope,
    timestamp: entry.timestamp,
    ...(text ? { text } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function importReplyCache(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): {
  imported: number;
  skipped: number;
} {
  const now = Date.now();
  const { entries, skipped } = parseJsonl(sourcePath, normalizeReplyCacheEntry);
  let imported = 0;
  for (const entry of entries) {
    if (entry.timestamp < now - REPLY_CACHE_TTL_MS) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: IMESSAGE_PLUGIN_ID,
      namespace: "reply-cache",
      key: replyCacheEntryKey(entry.messageId),
      value: entry,
      createdAt: entry.timestamp,
      expiresAt: entry.timestamp + REPLY_CACHE_TTL_MS,
      env,
    });
    imported += 1;
  }
  fs.rmSync(sourcePath, { force: true });
  return { imported, skipped };
}

function importSentEchoes(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): {
  imported: number;
  skipped: number;
} {
  const now = Date.now();
  const { entries, skipped } = parseJsonl(sourcePath, normalizeSentEchoEntry);
  let imported = 0;
  for (const entry of entries) {
    if (entry.timestamp < now - SENT_ECHO_TTL_MS) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: IMESSAGE_PLUGIN_ID,
      namespace: "sent-echoes",
      key: sentEchoEntryKey(entry),
      value: entry,
      createdAt: entry.timestamp,
      expiresAt: entry.timestamp + SENT_ECHO_TTL_MS,
      env,
    });
    imported += 1;
  }
  fs.rmSync(sourcePath, { force: true });
  return { imported, skipped };
}

function legacyCatchupCursorKey(filePath: string): string | null {
  const basename = path.basename(filePath, ".json");
  return /^[A-Za-z0-9_-]+__[a-f0-9]{12}$/u.test(basename) ? basename : null;
}

function importCatchupCursors(
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): {
  imported: number;
  skipped: number;
} {
  let imported = 0;
  let skipped = 0;
  const files = fs
    .readdirSync(sourcePath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(sourcePath, entry.name));

  for (const filePath of files) {
    const key = legacyCatchupCursorKey(filePath);
    if (!key) {
      skipped += 1;
      continue;
    }
    try {
      const cursor = normalizeIMessageCatchupCursor(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (!cursor) {
        skipped += 1;
        continue;
      }
      upsertPluginStateMigrationEntry({
        pluginId: IMESSAGE_PLUGIN_ID,
        namespace: "catchup-cursors",
        key,
        value: cursor,
        createdAt: cursor.updatedAt || Date.now(),
        env,
      });
      imported += 1;
      fs.rmSync(filePath, { force: true });
    } catch {
      skipped += 1;
    }
  }

  try {
    fs.rmdirSync(sourcePath);
  } catch {
    // Leave non-empty legacy dirs for a later doctor pass.
  }
  return { imported, skipped };
}

function imessagePluginStatePlan(params: {
  label: string;
  sourcePath: string;
  namespace: "reply-cache" | "sent-echoes" | "catchup-cursors";
  importSource: (
    sourcePath: string,
    env: NodeJS.ProcessEnv,
  ) => { imported: number; skipped: number };
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_state_entries:${IMESSAGE_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const { imported, skipped } = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${imported} ${params.label} row(s) into SQLite plugin state (${IMESSAGE_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings:
          skipped > 0
            ? [`Skipped ${skipped} invalid ${params.label} row(s) while importing legacy JSONL`]
            : [],
      };
    },
  };
}

export function detectIMessageLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  const replyCachePath = path.join(imessageDir(params.stateDir), "reply-cache.jsonl");
  if (fileExists(replyCachePath)) {
    plans.push(
      imessagePluginStatePlan({
        label: "iMessage reply cache",
        sourcePath: replyCachePath,
        namespace: "reply-cache",
        importSource: importReplyCache,
      }),
    );
  }
  const sentEchoesPath = path.join(imessageDir(params.stateDir), "sent-echoes.jsonl");
  if (fileExists(sentEchoesPath)) {
    plans.push(
      imessagePluginStatePlan({
        label: "iMessage sent echo cache",
        sourcePath: sentEchoesPath,
        namespace: "sent-echoes",
        importSource: importSentEchoes,
      }),
    );
  }
  const catchupPath = path.join(imessageDir(params.stateDir), "catchup");
  if (hasJsonFiles(catchupPath)) {
    plans.push(
      imessagePluginStatePlan({
        label: "iMessage catchup cursors",
        sourcePath: catchupPath,
        namespace: "catchup-cursors",
        importSource: importCatchupCursors,
      }),
    );
  }
  return plans;
}
