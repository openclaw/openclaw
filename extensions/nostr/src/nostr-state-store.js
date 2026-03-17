import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getNostrRuntime } from "./runtime.js";
const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;
function normalizeAccountId(accountId) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveNostrStatePath(accountId, env = process.env) {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `bus-state-${normalized}.json`);
}
function resolveNostrProfileStatePath(accountId, env = process.env) {
  const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "nostr", `profile-state-${normalized}.json`);
}
function safeParseState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 2) {
      return {
        version: 2,
        lastProcessedAt: typeof parsed.lastProcessedAt === "number" ? parsed.lastProcessedAt : null,
        gatewayStartedAt: typeof parsed.gatewayStartedAt === "number" ? parsed.gatewayStartedAt : null,
        recentEventIds: Array.isArray(parsed.recentEventIds) ? parsed.recentEventIds.filter((x) => typeof x === "string") : []
      };
    }
    if (parsed?.version === 1) {
      return {
        version: 2,
        lastProcessedAt: typeof parsed.lastProcessedAt === "number" ? parsed.lastProcessedAt : null,
        gatewayStartedAt: typeof parsed.gatewayStartedAt === "number" ? parsed.gatewayStartedAt : null,
        recentEventIds: []
      };
    }
    return null;
  } catch {
    return null;
  }
}
async function readNostrBusState(params) {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseState(raw);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}
async function writeNostrBusState(params) {
  const filePath = resolveNostrStatePath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 448 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload = {
    version: STORE_VERSION,
    lastProcessedAt: params.lastProcessedAt,
    gatewayStartedAt: params.gatewayStartedAt,
    recentEventIds: (params.recentEventIds ?? []).filter((x) => typeof x === "string")
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}
`, {
    encoding: "utf-8"
  });
  await fs.chmod(tmp, 384);
  await fs.rename(tmp, filePath);
}
function computeSinceTimestamp(state, nowSec = Math.floor(Date.now() / 1e3)) {
  if (!state) {
    return nowSec;
  }
  const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter(
    (t) => t !== null && t > 0
  );
  if (candidates.length === 0) {
    return nowSec;
  }
  return Math.max(...candidates);
}
function safeParseProfileState(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) {
      return {
        version: 1,
        lastPublishedAt: typeof parsed.lastPublishedAt === "number" ? parsed.lastPublishedAt : null,
        lastPublishedEventId: typeof parsed.lastPublishedEventId === "string" ? parsed.lastPublishedEventId : null,
        lastPublishResults: parsed.lastPublishResults && typeof parsed.lastPublishResults === "object" ? parsed.lastPublishResults : null
      };
    }
    return null;
  } catch {
    return null;
  }
}
async function readNostrProfileState(params) {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return safeParseProfileState(raw);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}
async function writeNostrProfileState(params) {
  const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 448 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const payload = {
    version: PROFILE_STATE_VERSION,
    lastPublishedAt: params.lastPublishedAt,
    lastPublishedEventId: params.lastPublishedEventId,
    lastPublishResults: params.lastPublishResults
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}
`, {
    encoding: "utf-8"
  });
  await fs.chmod(tmp, 384);
  await fs.rename(tmp, filePath);
}
export {
  computeSinceTimestamp,
  readNostrBusState,
  readNostrProfileState,
  writeNostrBusState,
  writeNostrProfileState
};
