import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** The authority of the caller whose embedded LLM stage produced checkpointed output. */
export type LobsterCheckpointCaller = {
  agentId?: string;
  /** Operator scopes, plus "model-override" when the host let the caller override models. */
  authority: string[];
};

export type LobsterLlmStage = { provider: string; command: string };

/**
 * What a Lobster checkpoint carries forward from LLM stages. Lobster persists the
 * output of completed stages at an approval or input checkpoint, and a resume
 * feeds that output to the remaining stages (or returns it) without running the
 * LLM stage again, so the LLM command wrapper never sees it. This record, written
 * when the checkpoint is handed to the caller, is how a resume knows it is about
 * to disclose or consume stored model output, and whose authority produced it.
 */
export type LobsterCheckpointProvenance = {
  version: 1;
  /** LLM stages whose output reached this checkpoint, directly or through an earlier checkpoint. */
  stages: LobsterLlmStage[];
  /** The caller whose authority produced embedded output, when any stage was embedded. */
  caller?: LobsterCheckpointCaller;
  /** The chain resumed a checkpoint this plugin holds no record of, so what it carries is unknown. */
  untrackedOrigin?: boolean;
};

export type LobsterCheckpointHandle = { token?: string; approvalId?: string };

type Env = Record<string, string | undefined>;

/** Namespace of the plugin SQLite keyed store that owns checkpoint provenance. */
export const CHECKPOINT_PROVENANCE_NAMESPACE = "lobster-checkpoint-provenance";

/**
 * A bounded namespace whose live rows track outstanding checkpoints, so its bound
 * is generous: reaching it means records are leaking, and "reject-new" then fails
 * the write rather than evicting a record a pending checkpoint still needs.
 */
export const CHECKPOINT_PROVENANCE_MAX_ENTRIES = 10_000;

/** The provenance sidecar directory that pre-dates the plugin state store. */
const LEGACY_RECORD_DIR = "openclaw-llm-checkpoints";

/**
 * The subset of the plugin SQLite keyed store provenance uses. A store from
 * api.runtime.state.openKeyedStore satisfies it structurally, so callers pass the
 * real store without an adapter.
 */
export type CheckpointProvenanceKeyedStore = {
  register(key: string, value: LobsterCheckpointProvenance): Promise<void>;
  lookup(key: string): Promise<LobsterCheckpointProvenance | undefined>;
  delete(key: string): Promise<boolean>;
};

let configuredStore: CheckpointProvenanceKeyedStore | undefined;

/**
 * Binds the plugin's SQLite-backed provenance store, opened once from
 * api.runtime.state.openKeyedStore by the plugin entry. Left unbound, records fall
 * back to the legacy sidecar directory: that keeps pre-upgrade records readable
 * and lets tests run without a host state store. Production always binds it, so no
 * new sidecar is written there.
 */
export function configureCheckpointProvenanceStore(
  store: CheckpointProvenanceKeyedStore | undefined,
): void {
  configuredStore = store;
}

// Mirrors Lobster's own state directory resolution, so a legacy record lives
// beside the checkpoint it describes and is backed up, moved or cleared with it.
function lobsterStateDir(env: Env): string {
  const configured = env.LOBSTER_STATE_DIR?.trim();
  return configured || path.join(os.homedir(), ".lobster", "state");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Lobster's storage identity for a state key. At @clawdbot/lobster state/store.js
 * keyToPath lowercases the key, replaces unsupported characters with "_", collapses
 * runs of "_" and trims boundary "_" before selecting `<stateDir>/<safe>.json`;
 * alternateWorkflowResumeStateKey additionally probes the "workflow-resume_" and
 * "workflow_resume_" spellings, which resolve to one stored state file. Two
 * encodings that select the same file must hash to one record, or a differently
 * normalized token resumes the checkpoint while missing its provenance and falls
 * through to the generic saved-answer check.
 */
function canonicalStateKey(stateKey: string): string {
  let safe = stateKey
    .toLowerCase()
    .replace("workflow-resume_", "workflow_resume_")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_");
  if (safe.startsWith("_")) {
    safe = safe.slice(1);
  }
  if (safe.endsWith("_")) {
    safe = safe.slice(0, -1);
  }
  return safe;
}

/**
 * The state key a Lobster resume token decodes to, mirroring @clawdbot/lobster
 * token.js: base64url JSON whose protocolVersion and v are both 1 and which
 * carries a stateKey. Lobster resumes by this key, so two encodings of the same
 * payload select the same checkpoint; provenance must key on the storage identity
 * of that key, not on the token bytes, or a re-encoded token would hash to a
 * different record and hide it. An undecodable token returns undefined, which
 * fails closed because Lobster cannot resume it either.
 */
function resumeTokenStateKey(token: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(payload) || payload.protocolVersion !== 1 || payload.v !== 1) {
    return undefined;
  }
  const stateKey = payload.stateKey;
  if (typeof stateKey !== "string" || !stateKey) {
    return undefined;
  }
  const canonical = canonicalStateKey(stateKey);
  return canonical || undefined;
}

/**
 * The canonical identities a checkpoint is recorded under: the decoded state key
 * from a resume token, and Lobster's approval-ID index key. Lobster strips every
 * non-hex character from an approval ID, so two spellings that sanitize alike
 * select the same checkpoint and must share one provenance record.
 */
function recordIdentityKeys(handle: LobsterCheckpointHandle): string[] {
  const keys: string[] = [];
  const token = handle.token?.trim();
  if (token) {
    const stateKey = resumeTokenStateKey(token);
    if (stateKey) {
      keys.push(`token:${stateKey}`);
    }
  }
  const approvalId = handle.approvalId?.trim();
  if (approvalId) {
    const safe = approvalId.replace(/[^a-f0-9]/g, "");
    if (safe) {
      keys.push(`approval:${safe}`);
    }
  }
  return keys;
}

/** The bounded store/sidecar keys for a handle, hashed so any identity fits the store key limit. */
function recordKeys(handle: LobsterCheckpointHandle): string[] {
  return recordIdentityKeys(handle).map((key) => createHash("sha256").update(key).digest("hex"));
}

function legacyRecordPath(env: Env, key: string): string {
  return path.join(lobsterStateDir(env), LEGACY_RECORD_DIR, `${key}.json`);
}

function parseProvenance(value: unknown, label: string): LobsterCheckpointProvenance {
  function fail(kind: "unreadable" | "malformed"): never {
    throw new Error(`lobster checkpoint provenance is ${kind}: ${label}`);
  }
  if (!isRecord(value) || value.version !== 1) {
    fail("malformed");
  }
  const stagesRaw = value.stages;
  if (!Array.isArray(stagesRaw)) {
    fail("malformed");
  }
  const stages: LobsterLlmStage[] = [];
  for (const stage of stagesRaw) {
    if (
      !isRecord(stage) ||
      typeof stage.provider !== "string" ||
      typeof stage.command !== "string"
    ) {
      fail("malformed");
    }
    stages.push({ provider: stage.provider, command: stage.command });
  }
  const record: LobsterCheckpointProvenance = { version: 1, stages };
  const callerRaw = value.caller;
  if (callerRaw !== undefined) {
    if (!isRecord(callerRaw)) {
      fail("malformed");
    }
    const authority = callerRaw.authority;
    const agentId = callerRaw.agentId;
    if (!isStringArray(authority) || (agentId !== undefined && typeof agentId !== "string")) {
      fail("malformed");
    }
    record.caller = { ...(agentId !== undefined ? { agentId } : {}), authority };
  }
  if (value.untrackedOrigin === true) {
    record.untrackedOrigin = true;
  }
  return record;
}

function parseRecord(text: string, label: string): LobsterCheckpointProvenance {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`lobster checkpoint provenance is unreadable: ${label}`);
  }
  return parseProvenance(value, label);
}

async function readLegacyRecord(
  env: Env,
  key: string,
): Promise<LobsterCheckpointProvenance | undefined> {
  let text: string;
  try {
    text = await fs.readFile(legacyRecordPath(env, key), "utf8");
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return parseRecord(text, key);
}

/**
 * Returns the record for a checkpoint, or undefined when this plugin never recorded
 * one. The plugin state store is authoritative; a legacy sidecar is read only for a
 * checkpoint recorded before the store existed, so an in-flight upgrade still honors
 * the producer's authority.
 */
export async function readCheckpointProvenance(
  env: Env,
  handle: LobsterCheckpointHandle,
): Promise<LobsterCheckpointProvenance | undefined> {
  const keys = recordKeys(handle);
  for (const key of keys) {
    if (!configuredStore) {
      break;
    }
    const stored = await configuredStore.lookup(key);
    if (stored !== undefined) {
      return parseProvenance(stored, key);
    }
  }
  for (const key of keys) {
    const legacy = await readLegacyRecord(env, key);
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

export async function writeCheckpointProvenance(
  env: Env,
  handle: LobsterCheckpointHandle,
  record: LobsterCheckpointProvenance,
): Promise<void> {
  const keys = recordKeys(handle);
  if (keys.length === 0) {
    return;
  }
  if (configuredStore) {
    for (const key of keys) {
      await configuredStore.register(key, record);
    }
    return;
  }
  const dir = path.join(lobsterStateDir(env), LEGACY_RECORD_DIR);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const text = JSON.stringify(record);
  for (const key of keys) {
    const file = legacyRecordPath(env, key);
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, text, { mode: 0o600 });
    await fs.rename(temp, file);
  }
}

/** Retires the record of a consumed checkpoint. A leftover record only makes a resume stricter. */
export async function deleteCheckpointProvenance(
  env: Env,
  handle: LobsterCheckpointHandle,
): Promise<void> {
  const keys = recordKeys(handle);
  if (configuredStore) {
    for (const key of keys) {
      await configuredStore.delete(key);
    }
  }
  await Promise.all(keys.map((key) => fs.rm(legacyRecordPath(env, key), { force: true })));
}
