import type { WebClient } from "@slack/web-api";
import {
  isRecord,
  normalizeTrimmedStringList,
  normalizeOptionalString,
  sortUniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackReadClient } from "./client.js";
import { formatSlackError } from "./errors.js";

export type SlackScopesResult = {
  ok: boolean;
  scopes?: string[];
  source?: string;
  error?: string;
};

type SlackScopesSource = "auth.scopes" | "apps.permissions.info";
type SlackScopesMethod = "auth.test" | SlackScopesSource;

function collectScopes(value: unknown, into: string[]) {
  if (Array.isArray(value) || typeof value === "string") {
    for (const scope of normalizeTrimmedStringList(
      typeof value === "string" ? value.split(/[,\s]+/) : value,
    )) {
      into.push(scope);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry) || typeof entry === "string") {
      collectScopes(entry, into);
    }
  }
}

function extractScopes(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const scopes: string[] = [];
  collectScopes(payload.scopes, scopes);
  collectScopes(payload.scope, scopes);
  if (isRecord(payload.response_metadata)) {
    collectScopes(payload.response_metadata.scopes, scopes);
  }
  if (isRecord(payload.info)) {
    collectScopes(payload.info.scopes, scopes);
    collectScopes(payload.info.scope, scopes);
    collectScopes(payload.info.user_scopes, scopes);
    collectScopes(payload.info.bot_scopes, scopes);
  }
  return sortUniqueStrings(scopes);
}

async function callSlack(
  client: WebClient,
  method: SlackScopesMethod,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await client.apiCall(method);
    return isRecord(result) ? result : null;
  } catch (err) {
    return {
      ok: false,
      error: formatSlackError(err),
    };
  }
}

export async function fetchSlackScopes(
  token: string,
  timeoutMs: number,
): Promise<SlackScopesResult> {
  const client = createSlackReadClient(token, { timeout: timeoutMs });
  const attempts: SlackScopesMethod[] = ["auth.test", "auth.scopes", "apps.permissions.info"];
  const errors: string[] = [];

  for (const method of attempts) {
    const result = await callSlack(client, method);
    const scopes = extractScopes(result);
    if (scopes.length > 0) {
      return { ok: true, scopes, source: method };
    }
    const error = isRecord(result) ? normalizeOptionalString(result.error) : undefined;
    if (error) {
      errors.push(`${method}: ${error}`);
    }
  }

  return {
    ok: false,
    error: errors.length > 0 ? errors.join(" | ") : "no scopes returned",
  };
}
