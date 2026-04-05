import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../runtime-api.js";
import { createFileSessionStore, type AcpSessionRecord } from "./runtime.js";

const LEGACY_SESSION_RECORD_SCHEMA = "openclaw.acpx.session.v1" as const;
const CURRENT_SESSION_RECORD_SCHEMA = "acpx.session.v1" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNullableInteger(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return asInteger(value);
}

function asNullableSignal(value: unknown): NodeJS.Signals | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? (value as NodeJS.Signals) : undefined;
}

function toCurrentSessionRecord(raw: unknown): AcpSessionRecord | null {
  const record = asRecord(raw);
  if (!record || record.schema !== LEGACY_SESSION_RECORD_SCHEMA) {
    return null;
  }

  const acpxRecordId = asString(record.acpxRecordId);
  const acpSessionId = asString(record.acpSessionId);
  const agentCommand = asString(record.agentCommand);
  const cwd = asString(record.cwd);
  const createdAt = asString(record.createdAt);
  const lastUsedAt = asString(record.lastUsedAt);
  const lastSeq = asInteger(record.lastSeq);
  const updatedAt = asString(record.updated_at);
  const messages = Array.isArray(record.messages)
    ? (record.messages as AcpSessionRecord["messages"])
    : undefined;

  if (
    !acpxRecordId ||
    !acpSessionId ||
    !agentCommand ||
    !cwd ||
    !createdAt ||
    !lastUsedAt ||
    lastSeq == null ||
    lastSeq < 0 ||
    !updatedAt ||
    !messages
  ) {
    return null;
  }

  const title = record.title;
  const name = record.name;
  const requestTokenUsage = asRecord(record.request_token_usage);
  const cumulativeTokenUsage = asRecord(record.cumulative_token_usage);

  return {
    schema: CURRENT_SESSION_RECORD_SCHEMA,
    acpxRecordId,
    acpSessionId,
    agentSessionId: asString(record.agentSessionId),
    agentCommand,
    cwd,
    name: typeof name === "string" ? name : undefined,
    createdAt,
    lastUsedAt,
    lastSeq,
    lastRequestId: asString(record.lastRequestId),
    eventLog: (asRecord(record.eventLog) ?? {}) as AcpSessionRecord["eventLog"],
    closed: asBoolean(record.closed) ?? false,
    closedAt: asString(record.closedAt),
    pid: asPositiveInteger(record.pid),
    agentStartedAt: asString(record.agentStartedAt),
    lastPromptAt: asString(record.lastPromptAt),
    lastAgentExitCode: asNullableInteger(record.lastAgentExitCode),
    lastAgentExitSignal: asNullableSignal(record.lastAgentExitSignal),
    lastAgentExitAt: asString(record.lastAgentExitAt),
    lastAgentDisconnectReason: asString(record.lastAgentDisconnectReason),
    protocolVersion: asInteger(record.protocolVersion),
    agentCapabilities: (asRecord(record.agentCapabilities) ??
      undefined) as AcpSessionRecord["agentCapabilities"],
    title: typeof title === "string" || title === null ? title : undefined,
    messages,
    updated_at: updatedAt,
    cumulative_token_usage: (cumulativeTokenUsage ??
      {}) as AcpSessionRecord["cumulative_token_usage"],
    request_token_usage: (requestTokenUsage ?? {}) as AcpSessionRecord["request_token_usage"],
    acpx: (asRecord(record.acpx) ?? undefined) as AcpSessionRecord["acpx"],
  };
}

export async function migrateLegacyAcpxSessions(params: {
  stateDir: string;
  logger?: PluginLogger;
}): Promise<void> {
  const sessionDir = path.join(params.stateDir, "sessions");
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  const store = createFileSessionStore({ stateDir: params.stateDir });
  let migratedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(sessionDir, entry.name);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      const migratedRecord = toCurrentSessionRecord(payload);
      if (!migratedRecord) {
        continue;
      }
      await store.save(migratedRecord);
      migratedCount += 1;
    } catch (error) {
      params.logger?.warn(
        `failed to migrate legacy ACPX session file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (migratedCount > 0) {
    params.logger?.info(`migrated ${migratedCount} legacy ACPX session file(s)`);
  }
}
