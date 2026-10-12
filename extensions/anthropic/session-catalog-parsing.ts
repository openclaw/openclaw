import {
  isRecord,
  normalizeBoundedOptionalString as readBoundedString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { MAX_STRING_LENGTH, parsePullRequestSummary } from "./session-catalog-desktop.js";
import { ClaudeCatalogParamsError } from "./session-catalog-shared.js";
import type {
  ClaudeSessionCatalogPage,
  ClaudeSessionCatalogSession,
} from "./session-catalog-types.js";

const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
const DEFAULT_TRANSCRIPT_LIMIT = 20;
export const MAX_TRANSCRIPT_LIMIT = 50;
export const MAX_HOSTS = 100;
const MAX_SEARCH_LENGTH = 500;

export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeOffset(cursor: string | undefined, label: string): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!isExactClaudeSessionCursor(cursor)) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`);
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("invalid offset");
    }
    return parsed.offset as number;
  } catch (error) {
    throw new ClaudeCatalogParamsError(`${label} cursor is invalid`, { cause: error });
  }
}

function readLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new ClaudeCatalogParamsError(`limit must be an integer from 1 to ${max}`);
  }
  return value as number;
}

function readRequiredCursor(value: unknown, message: string): string {
  if (!isExactClaudeSessionCursor(value)) {
    throw new ClaudeCatalogParamsError(message);
  }
  return value;
}

export function readOptionalCursor(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredCursor(value, `${label} cursor is invalid`);
}

function readParams(
  value: unknown,
  scope: "catalog" | "read",
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ClaudeCatalogParamsError(`Claude session ${scope} parameters must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ClaudeCatalogParamsError(`unknown Claude session ${scope} parameter: ${unknown}`);
  }
  return value;
}

export function readListParams(value: unknown) {
  if (value === undefined || value === null) {
    return { limit: DEFAULT_PAGE_LIMIT };
  }
  const params = readParams(value, "catalog", ["cursor", "limit", "searchTerm"]);
  const cursor = readOptionalCursor(params.cursor, "catalog");
  const searchTerm = readBoundedString(params.searchTerm, MAX_SEARCH_LENGTH);
  return {
    limit: readLimit(params.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(cursor ? { cursor } : {}),
    ...(searchTerm ? { searchTerm } : {}),
  };
}

export function readTranscriptParams(value: unknown) {
  const params = readParams(value, "read", ["threadId", "cursor", "limit"]);
  const threadId = readBoundedString(params.threadId, 256);
  if (!threadId || !/^[A-Za-z0-9._:-]+$/.test(threadId)) {
    throw new ClaudeCatalogParamsError("threadId is invalid");
  }
  const cursor = readOptionalCursor(params.cursor, "transcript");
  return {
    threadId,
    limit: readLimit(params.limit, DEFAULT_TRANSCRIPT_LIMIT, MAX_TRANSCRIPT_LIMIT),
    ...(cursor ? { cursor } : {}),
  };
}

export function readNodePageCursor(
  value: Record<string, unknown>,
  invalidPageMessage: string,
): string | undefined {
  if (!("nextCursor" in value)) {
    return undefined;
  }
  if (!isExactClaudeSessionCursor(value.nextCursor)) {
    throw new Error(invalidPageMessage);
  }
  return value.nextCursor;
}

export function parseCatalogPage(value: unknown): ClaudeSessionCatalogPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Claude node returned an invalid session page");
  }
  const sessions = value.sessions.map((candidate): ClaudeSessionCatalogSession => {
    if (!isRecord(candidate)) {
      throw new Error("Claude node returned an invalid session");
    }
    const threadId = readBoundedString(candidate.threadId, 256);
    const source = candidate.source;
    if (
      !threadId ||
      candidate.archived !== false ||
      candidate.status !== "stored" ||
      (source !== "claude-cli" && source !== "claude-desktop") ||
      candidate.modelProvider !== "anthropic"
    ) {
      throw new Error("Claude node returned an invalid session");
    }
    const session: ClaudeSessionCatalogSession = {
      threadId,
      status: "stored",
      source,
      modelProvider: "anthropic",
      archived: false,
    };
    for (const [key, maxLength] of [
      ["name", 500],
      ["cwd", MAX_STRING_LENGTH],
      ["color", MAX_STRING_LENGTH],
      ["cliVersion", 256],
      ["gitBranch", 500],
    ] as const) {
      if (key === "name" && candidate[key] === null) {
        session.name = null;
        continue;
      }
      if (!(key in candidate)) {
        continue;
      }
      const parsed = readBoundedString(candidate[key], maxLength);
      if (!parsed) {
        throw new Error("Claude node returned an invalid session");
      }
      session[key] = parsed;
    }
    for (const key of ["createdAt", "updatedAt", "recencyAt"] as const) {
      if (!(key in candidate)) {
        continue;
      }
      if (key === "recencyAt" && candidate[key] === null) {
        session.recencyAt = null;
        continue;
      }
      const parsed = candidate[key];
      if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        throw new Error("Claude node returned an invalid session");
      }
      session[key] = parsed;
    }
    const pullRequest = parsePullRequestSummary(candidate.pullRequest);
    if (pullRequest) {
      session.pullRequest = pullRequest;
    }
    return session;
  });
  const nextCursor = readNodePageCursor(value, "Claude node returned an invalid session page");
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

export function unwrapNodePayload(value: unknown): unknown {
  if (isRecord(value) && typeof value.payloadJSON === "string") {
    return JSON.parse(value.payloadJSON) as unknown;
  }
  return value;
}

export function parseGatewayQuery(value: unknown) {
  if (value === undefined || value === null) {
    return { limitPerHost: DEFAULT_PAGE_LIMIT };
  }
  const params = readParams(value, "catalog", ["search", "limitPerHost", "hostIds", "cursors"]);
  const search = readBoundedString(params.search, MAX_SEARCH_LENGTH);
  let hostIds: string[] | undefined;
  if (params.hostIds !== undefined) {
    if (!Array.isArray(params.hostIds) || params.hostIds.length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("hostIds must be a bounded array");
    }
    hostIds = [
      ...new Set(
        params.hostIds.map((hostId) => {
          const normalized = readBoundedString(hostId, 256);
          if (
            !normalized ||
            (normalized !== CLAUDE_LOCAL_SESSION_HOST_ID && !normalized.startsWith("node:"))
          ) {
            throw new ClaudeCatalogParamsError("hostId is invalid");
          }
          return normalized;
        }),
      ),
    ];
  }
  let cursors: Record<string, string> | undefined;
  if (params.cursors !== undefined) {
    if (!isRecord(params.cursors) || Object.keys(params.cursors).length > MAX_HOSTS) {
      throw new ClaudeCatalogParamsError("cursors must be a bounded object");
    }
    cursors = Object.fromEntries(
      Object.entries(params.cursors).map(([hostId, cursor]) => {
        return [hostId, readRequiredCursor(cursor, `cursor for ${hostId} is invalid`)];
      }),
    );
  }
  return {
    limitPerHost: readLimit(params.limitPerHost, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    ...(search ? { search } : {}),
    ...(hostIds ? { hostIds } : {}),
    ...(cursors ? { cursors } : {}),
  };
}
