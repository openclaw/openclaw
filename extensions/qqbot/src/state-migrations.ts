import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import { upsertPluginStateMigrationEntry } from "openclaw/plugin-sdk/migration-runtime";

const QQBOT_PLUGIN_ID = "qqbot";
const QQBOT_SESSION_TTL_MS = 5 * 60 * 1000;
const QQBOT_REF_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countJsonlRecords(filePath: string): number | undefined {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return undefined;
  }
}

function makeKnownUserKey(user: Record<string, unknown>): string | null {
  const accountId = typeof user.accountId === "string" ? user.accountId : "";
  const type = typeof user.type === "string" ? user.type : "";
  const openid = typeof user.openid === "string" ? user.openid : "";
  if (!accountId || !type || !openid) {
    return null;
  }
  const base = `${accountId}:${type}:${openid}`;
  return type === "group" && typeof user.groupOpenid === "string" && user.groupOpenid
    ? `${base}:${user.groupOpenid}`
    : base;
}

function importKnownUsers(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("known-users.json must contain an array");
  }
  let imported = 0;
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const user = value as Record<string, unknown>;
    const key = makeKnownUserKey(user);
    if (!key) {
      continue;
    }
    const createdAt =
      typeof user.firstSeenAt === "number" && Number.isFinite(user.firstSeenAt)
        ? user.firstSeenAt
        : Date.now();
    upsertPluginStateMigrationEntry({
      pluginId: QQBOT_PLUGIN_ID,
      namespace: "known-users",
      key,
      value: user,
      createdAt,
      env,
    });
    imported++;
  }
  fs.rmSync(sourcePath, { force: true });
  return imported;
}

function importRefIndex(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const now = Date.now();
  let imported = 0;
  for (const [index, line] of fs.readFileSync(sourcePath, "utf8").split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid ref-index entry at ${sourcePath}:${index + 1}`);
    }
    const entry = parsed as Record<string, unknown>;
    const key = typeof entry.k === "string" ? entry.k : "";
    const value = entry.v;
    const createdAt = typeof entry.t === "number" && Number.isFinite(entry.t) ? entry.t : 0;
    if (!key || !value || typeof value !== "object" || Array.isArray(value) || createdAt <= 0) {
      continue;
    }
    if (now - createdAt > QQBOT_REF_INDEX_TTL_MS) {
      continue;
    }
    upsertPluginStateMigrationEntry({
      pluginId: QQBOT_PLUGIN_ID,
      namespace: "ref-index",
      key,
      value: { ...(value as Record<string, unknown>), createdAt },
      createdAt,
      expiresAt: createdAt + QQBOT_REF_INDEX_TTL_MS,
      env,
    });
    imported++;
  }
  fs.rmSync(sourcePath, { force: true });
  return imported;
}

function importSession(sourcePath: string, env: NodeJS.ProcessEnv): number {
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QQBot session file must contain an object");
  }
  const session = parsed as Record<string, unknown>;
  const accountId = typeof session.accountId === "string" ? session.accountId : "";
  const savedAt =
    typeof session.savedAt === "number" && Number.isFinite(session.savedAt)
      ? session.savedAt
      : Date.now();
  if (!accountId || Date.now() - savedAt > QQBOT_SESSION_TTL_MS) {
    fs.rmSync(sourcePath, { force: true });
    return 0;
  }
  upsertPluginStateMigrationEntry({
    pluginId: QQBOT_PLUGIN_ID,
    namespace: "sessions",
    key: accountId,
    value: session,
    createdAt: savedAt,
    expiresAt: savedAt + QQBOT_SESSION_TTL_MS,
    env,
  });
  fs.rmSync(sourcePath, { force: true });
  return 1;
}

function qqbotPluginStatePlan(params: {
  label: string;
  sourcePath: string;
  namespace: "known-users" | "ref-index" | "sessions";
  recordCount?: number;
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => number;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_state_entries:${QQBOT_PLUGIN_ID}/${params.namespace}`,
    recordCount: params.recordCount,
    apply: ({ env }) => {
      const imported = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${imported} ${params.label} row(s) into SQLite plugin state (${QQBOT_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: [],
      };
    },
  };
}

export function detectQQBotLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  const dataDir = path.join(params.stateDir, "qqbot", "data");
  const sessionsDir = path.join(params.stateDir, "qqbot", "sessions");
  const knownUsersPath = path.join(dataDir, "known-users.json");
  const refIndexPath = path.join(dataDir, "ref-index.jsonl");

  if (fileExists(knownUsersPath)) {
    plans.push(
      qqbotPluginStatePlan({
        label: "QQBot known users",
        sourcePath: knownUsersPath,
        namespace: "known-users",
        importSource: importKnownUsers,
      }),
    );
  }
  if (fileExists(refIndexPath)) {
    plans.push(
      qqbotPluginStatePlan({
        label: "QQBot ref-index",
        sourcePath: refIndexPath,
        namespace: "ref-index",
        recordCount: countJsonlRecords(refIndexPath),
        importSource: importRefIndex,
      }),
    );
  }
  for (const entry of safeReadDir(sessionsDir)) {
    if (!entry.isFile() || !entry.name.startsWith("session-") || !entry.name.endsWith(".json")) {
      continue;
    }
    plans.push(
      qqbotPluginStatePlan({
        label: "QQBot gateway session",
        sourcePath: path.join(sessionsDir, entry.name),
        namespace: "sessions",
        recordCount: 1,
        importSource: importSession,
      }),
    );
  }

  return plans;
}
