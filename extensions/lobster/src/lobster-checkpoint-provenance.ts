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

const RECORD_DIR = "openclaw-llm-checkpoints";

// Mirrors Lobster's own state directory resolution, so a record lives beside
// the checkpoint it describes and is backed up, moved or cleared with it.
function lobsterStateDir(env: Env): string {
  const configured = env.LOBSTER_STATE_DIR?.trim();
  return configured || path.join(os.homedir(), ".lobster", "state");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Lobster's two state-key spellings for one workflow checkpoint, collapsed to one. */
function canonicalStateKey(stateKey: string): string {
  return stateKey.includes("workflow-resume_")
    ? stateKey.replace("workflow-resume_", "workflow_resume_")
    : stateKey;
}

/**
 * The state key a Lobster resume token decodes to, mirroring @clawdbot/lobster
 * token.js: base64url JSON whose protocolVersion and v are both 1 and which
 * carries a stateKey. Lobster resumes by this key, so two encodings of the same
 * payload select the same checkpoint; provenance must key on it, not on the
 * token bytes, or a re-encoded token would hash to a different filename and hide
 * the record. An undecodable token returns undefined, which fails closed because
 * Lobster cannot resume it either.
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
  return typeof stateKey === "string" && stateKey ? canonicalStateKey(stateKey) : undefined;
}

/**
 * The canonical keys a checkpoint is recorded under: the decoded state key from a
 * resume token, and Lobster's approval-ID index key. Lobster strips every
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

function recordPaths(env: Env, handle: LobsterCheckpointHandle): string[] {
  const dir = path.join(lobsterStateDir(env), RECORD_DIR);
  return recordIdentityKeys(handle).map((key) =>
    path.join(dir, `${createHash("sha256").update(key).digest("hex")}.json`),
  );
}

function parseRecord(text: string, file: string): LobsterCheckpointProvenance {
  function fail(kind: "unreadable" | "malformed"): never {
    throw new Error(`lobster checkpoint provenance is ${kind}: ${path.basename(file)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("unreadable");
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

/** Returns the record for a checkpoint, or undefined when this plugin never recorded one. */
export async function readCheckpointProvenance(
  env: Env,
  handle: LobsterCheckpointHandle,
): Promise<LobsterCheckpointProvenance | undefined> {
  for (const file of recordPaths(env, handle)) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (extractErrorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    return parseRecord(text, file);
  }
  return undefined;
}

export async function writeCheckpointProvenance(
  env: Env,
  handle: LobsterCheckpointHandle,
  record: LobsterCheckpointProvenance,
): Promise<void> {
  const files = recordPaths(env, handle);
  const primary = files[0];
  if (primary === undefined) {
    return;
  }
  await fs.mkdir(path.dirname(primary), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(record);
  for (const file of files) {
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
  await Promise.all(recordPaths(env, handle).map((file) => fs.rm(file, { force: true })));
}
