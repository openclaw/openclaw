import fs from "node:fs";
import path from "node:path";
import type { ChannelLegacyStateMigrationPlan } from "openclaw/plugin-sdk/channel-contract";
import {
  upsertPluginBlobMigrationEntry,
  upsertPluginStateMigrationEntry,
} from "openclaw/plugin-sdk/migration-runtime";
import type { StoredConversationReference } from "./conversation-store.js";
import type { MSTeamsPoll } from "./polls.js";
import {
  MSTEAMS_SSO_TOKEN_NAMESPACE,
  MSTEAMS_SSO_TOKEN_STORE_FILENAME,
  parseMSTeamsSsoTokenStoreData,
} from "./sso-token-store.js";
import {
  MSTEAMS_DELEGATED_TOKEN_FILENAME,
  MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
  parseMSTeamsDelegatedTokens,
} from "./token.js";

const MSTEAMS_PLUGIN_ID = "msteams";
const PENDING_UPLOAD_TTL_MS = 5 * 60 * 1000;
const LEARNINGS_SUFFIX = ".learnings.json";

type ImportResult = {
  imported: number;
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function removeEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    // Best effort: migration correctness is the imported row + removed source file.
  }
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseConversations(raw: unknown): Record<string, StoredConversationReference> | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.conversations)) {
    return null;
  }
  const out: Record<string, StoredConversationReference> = {};
  for (const [id, reference] of Object.entries(raw.conversations)) {
    if (!id || !isRecord(reference) || !isRecord(reference.conversation)) {
      continue;
    }
    out[id] = compactRecord(reference) as StoredConversationReference;
  }
  return out;
}

function parsePolls(raw: unknown): Record<string, MSTeamsPoll> | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.polls)) {
    return null;
  }
  const out: Record<string, MSTeamsPoll> = {};
  for (const [id, poll] of Object.entries(raw.polls)) {
    if (
      !id ||
      !isRecord(poll) ||
      typeof poll.id !== "string" ||
      typeof poll.question !== "string" ||
      !Array.isArray(poll.options) ||
      typeof poll.maxSelections !== "number" ||
      typeof poll.createdAt !== "string" ||
      !isRecord(poll.votes)
    ) {
      continue;
    }
    out[id] = compactRecord(poll) as MSTeamsPoll;
  }
  return out;
}

function importConversations(filePath: string, env: NodeJS.ProcessEnv): ImportResult {
  const warnings: string[] = [];
  const conversations = parseConversations(readJsonFile(filePath));
  if (!conversations) {
    return {
      imported: 0,
      warnings: [`Skipped invalid Microsoft Teams conversation file: ${filePath}`],
    };
  }
  let imported = 0;
  for (const [key, reference] of Object.entries(conversations)) {
    upsertPluginStateMigrationEntry({
      pluginId: MSTEAMS_PLUGIN_ID,
      namespace: "conversations",
      key,
      value: reference,
      createdAt: Date.parse(reference.lastSeenAt ?? "") || Date.now(),
      env,
    });
    imported++;
  }
  fs.rmSync(filePath, { force: true });
  return { imported, warnings };
}

function importPolls(filePath: string, env: NodeJS.ProcessEnv): ImportResult {
  const warnings: string[] = [];
  const polls = parsePolls(readJsonFile(filePath));
  if (!polls) {
    return { imported: 0, warnings: [`Skipped invalid Microsoft Teams poll file: ${filePath}`] };
  }
  let imported = 0;
  for (const [key, poll] of Object.entries(polls)) {
    const updatedAt = Date.parse(poll.updatedAt ?? poll.createdAt) || Date.now();
    upsertPluginStateMigrationEntry({
      pluginId: MSTEAMS_PLUGIN_ID,
      namespace: "polls",
      key,
      value: poll,
      createdAt: updatedAt,
      expiresAt: updatedAt + 30 * 24 * 60 * 60 * 1000,
      env,
    });
    imported++;
  }
  fs.rmSync(filePath, { force: true });
  return { imported, warnings };
}

function importSsoTokens(filePath: string, env: NodeJS.ProcessEnv): ImportResult {
  const tokens = parseMSTeamsSsoTokenStoreData(readJsonFile(filePath));
  if (!tokens) {
    return {
      imported: 0,
      warnings: [`Skipped invalid Microsoft Teams SSO token file: ${filePath}`],
    };
  }
  let imported = 0;
  for (const [key, token] of Object.entries(tokens)) {
    upsertPluginStateMigrationEntry({
      pluginId: MSTEAMS_PLUGIN_ID,
      namespace: MSTEAMS_SSO_TOKEN_NAMESPACE,
      key,
      value: token,
      createdAt: Date.parse(token.updatedAt) || Date.now(),
      env,
    });
    imported++;
  }
  fs.rmSync(filePath, { force: true });
  return { imported, warnings: [] };
}

function importDelegatedTokens(filePath: string, env: NodeJS.ProcessEnv): ImportResult {
  const tokens = parseMSTeamsDelegatedTokens(readJsonFile(filePath));
  if (!tokens) {
    return {
      imported: 0,
      warnings: [`Skipped invalid Microsoft Teams delegated token file: ${filePath}`],
    };
  }
  upsertPluginStateMigrationEntry({
    pluginId: MSTEAMS_PLUGIN_ID,
    namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
    key: "current",
    value: tokens,
    createdAt: Date.now(),
    env,
  });
  fs.rmSync(filePath, { force: true });
  return { imported: 1, warnings: [] };
}

function importPendingUploads(filePath: string, env: NodeJS.ProcessEnv): ImportResult {
  const raw = readJsonFile(filePath);
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.uploads)) {
    return {
      imported: 0,
      warnings: [`Skipped invalid Microsoft Teams pending upload file: ${filePath}`],
    };
  }
  let imported = 0;
  const warnings: string[] = [];
  for (const [key, upload] of Object.entries(raw.uploads)) {
    if (
      !isRecord(upload) ||
      typeof upload.id !== "string" ||
      typeof upload.bufferBase64 !== "string" ||
      typeof upload.filename !== "string" ||
      typeof upload.conversationId !== "string" ||
      typeof upload.createdAt !== "number"
    ) {
      warnings.push(`Skipped invalid Microsoft Teams pending upload entry in: ${filePath}`);
      continue;
    }
    const metadata = compactRecord({
      id: upload.id,
      filename: upload.filename,
      contentType: typeof upload.contentType === "string" ? upload.contentType : undefined,
      conversationId: upload.conversationId,
      consentCardActivityId:
        typeof upload.consentCardActivityId === "string" ? upload.consentCardActivityId : undefined,
      createdAt: Math.floor(upload.createdAt),
    });
    upsertPluginBlobMigrationEntry({
      pluginId: MSTEAMS_PLUGIN_ID,
      namespace: "pending-uploads",
      key,
      metadata,
      blob: Buffer.from(upload.bufferBase64, "base64"),
      createdAt: metadata.createdAt,
      expiresAt: metadata.createdAt + PENDING_UPLOAD_TTL_MS,
      env,
    });
    imported++;
  }
  fs.rmSync(filePath, { force: true });
  return { imported, warnings };
}

function collectLearningFiles(root: string): string[] {
  const matches: string[] = [];
  function visit(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(LEARNINGS_SUFFIX)) {
        matches.push(entryPath);
      }
    }
  }
  visit(root);
  return matches.toSorted();
}

function importLearnings(root: string, env: NodeJS.ProcessEnv): ImportResult {
  let imported = 0;
  const warnings: string[] = [];
  for (const filePath of collectLearningFiles(root)) {
    const raw = readJsonFile(filePath);
    if (!Array.isArray(raw)) {
      warnings.push(`Skipped invalid Microsoft Teams feedback learning file: ${filePath}`);
      continue;
    }
    const learnings = raw.filter((entry): entry is string => typeof entry === "string").slice(-10);
    upsertPluginStateMigrationEntry({
      pluginId: MSTEAMS_PLUGIN_ID,
      namespace: "feedback-learnings",
      key: path.basename(filePath, LEARNINGS_SUFFIX),
      value: { learnings, updatedAt: Date.now() },
      createdAt: Date.now(),
      env,
    });
    fs.rmSync(filePath, { force: true });
    removeEmptyDir(path.dirname(filePath));
    imported++;
  }
  return { imported, warnings };
}

function pluginStatePlan(params: {
  label: string;
  sourcePath: string;
  namespace:
    | "conversations"
    | "polls"
    | "feedback-learnings"
    | typeof MSTEAMS_SSO_TOKEN_NAMESPACE
    | typeof MSTEAMS_DELEGATED_TOKEN_NAMESPACE;
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => ImportResult;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_state_entries:${MSTEAMS_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const result = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${result.imported} ${params.label} row(s) into SQLite plugin state (${MSTEAMS_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: result.warnings,
      };
    },
  };
}

function pluginBlobPlan(params: {
  label: string;
  sourcePath: string;
  namespace: "pending-uploads";
  importSource: (sourcePath: string, env: NodeJS.ProcessEnv) => ImportResult;
}): ChannelLegacyStateMigrationPlan {
  return {
    kind: "custom",
    label: params.label,
    sourcePath: params.sourcePath,
    targetTable: `plugin_blob_entries:${MSTEAMS_PLUGIN_ID}/${params.namespace}`,
    apply: ({ env }) => {
      const result = params.importSource(params.sourcePath, env);
      return {
        changes: [
          `Imported ${result.imported} ${params.label} row(s) into SQLite plugin blobs (${MSTEAMS_PLUGIN_ID}/${params.namespace})`,
        ],
        warnings: result.warnings,
      };
    },
  };
}

export function detectMSTeamsLegacyStateMigrations(params: {
  stateDir: string;
}): ChannelLegacyStateMigrationPlan[] {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  const conversations = path.join(params.stateDir, "msteams-conversations.json");
  if (fs.existsSync(conversations)) {
    plans.push(
      pluginStatePlan({
        label: "Microsoft Teams conversation",
        sourcePath: conversations,
        namespace: "conversations",
        importSource: importConversations,
      }),
    );
  }
  const polls = path.join(params.stateDir, "msteams-polls.json");
  if (fs.existsSync(polls)) {
    plans.push(
      pluginStatePlan({
        label: "Microsoft Teams poll",
        sourcePath: polls,
        namespace: "polls",
        importSource: importPolls,
      }),
    );
  }
  const pendingUploads = path.join(params.stateDir, "msteams-pending-uploads.json");
  if (fs.existsSync(pendingUploads)) {
    plans.push(
      pluginBlobPlan({
        label: "Microsoft Teams pending upload",
        sourcePath: pendingUploads,
        namespace: "pending-uploads",
        importSource: importPendingUploads,
      }),
    );
  }
  const ssoTokens = path.join(params.stateDir, MSTEAMS_SSO_TOKEN_STORE_FILENAME);
  if (fs.existsSync(ssoTokens)) {
    plans.push(
      pluginStatePlan({
        label: "Microsoft Teams SSO token",
        sourcePath: ssoTokens,
        namespace: MSTEAMS_SSO_TOKEN_NAMESPACE,
        importSource: importSsoTokens,
      }),
    );
  }
  const delegatedTokens = path.join(params.stateDir, MSTEAMS_DELEGATED_TOKEN_FILENAME);
  if (fs.existsSync(delegatedTokens)) {
    plans.push(
      pluginStatePlan({
        label: "Microsoft Teams delegated token",
        sourcePath: delegatedTokens,
        namespace: MSTEAMS_DELEGATED_TOKEN_NAMESPACE,
        importSource: importDelegatedTokens,
      }),
    );
  }
  if (collectLearningFiles(params.stateDir).length > 0) {
    plans.push(
      pluginStatePlan({
        label: "Microsoft Teams feedback learning",
        sourcePath: params.stateDir,
        namespace: "feedback-learnings",
        importSource: importLearnings,
      }),
    );
  }
  return plans;
}
