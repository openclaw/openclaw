import { isRecord } from "../../../src/utils.js";
import { createSlackWebClient } from "./client.js";
function collectScopes(value, into) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        into.push(entry.trim());
      }
    }
    return;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return;
    }
    const parts = raw.split(/[,\s]+/).map((part) => part.trim());
    for (const part of parts) {
      if (part) {
        into.push(part);
      }
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
function normalizeScopes(scopes) {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).toSorted();
}
function extractScopes(payload) {
  if (!isRecord(payload)) {
    return [];
  }
  const scopes = [];
  collectScopes(payload.scopes, scopes);
  collectScopes(payload.scope, scopes);
  if (isRecord(payload.info)) {
    collectScopes(payload.info.scopes, scopes);
    collectScopes(payload.info.scope, scopes);
    collectScopes(payload.info.user_scopes, scopes);
    collectScopes(payload.info.bot_scopes, scopes);
  }
  return normalizeScopes(scopes);
}
function readError(payload) {
  if (!isRecord(payload)) {
    return void 0;
  }
  const error = payload.error;
  return typeof error === "string" && error.trim() ? error.trim() : void 0;
}
async function callSlack(client, method) {
  try {
    const result = await client.apiCall(method);
    return isRecord(result) ? result : null;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function fetchSlackScopes(token, timeoutMs) {
  const client = createSlackWebClient(token, { timeout: timeoutMs });
  const attempts = ["auth.scopes", "apps.permissions.info"];
  const errors = [];
  for (const method of attempts) {
    const result = await callSlack(client, method);
    const scopes = extractScopes(result);
    if (scopes.length > 0) {
      return { ok: true, scopes, source: method };
    }
    const error = readError(result);
    if (error) {
      errors.push(`${method}: ${error}`);
    }
  }
  return {
    ok: false,
    error: errors.length > 0 ? errors.join(" | ") : "no scopes returned"
  };
}
export {
  fetchSlackScopes
};
