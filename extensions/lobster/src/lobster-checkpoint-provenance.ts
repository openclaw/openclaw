import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";

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

function recordPaths(env: Env, handle: LobsterCheckpointHandle): string[] {
  const dir = path.join(lobsterStateDir(env), RECORD_DIR);
  const keys = [
    handle.token?.trim() ? `token:${handle.token.trim()}` : "",
    handle.approvalId?.trim() ? `approval:${handle.approvalId.trim()}` : "",
  ].filter(Boolean);
  return keys.map((key) =>
    path.join(dir, `${createHash("sha256").update(key).digest("hex")}.json`),
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseRecord(text: string, file: string): LobsterCheckpointProvenance {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`lobster checkpoint provenance is unreadable: ${path.basename(file)}`);
  }
  const record = value as Partial<LobsterCheckpointProvenance> | null;
  const stagesValid =
    Array.isArray(record?.stages) &&
    record.stages.every(
      (stage) =>
        Boolean(stage) && typeof stage.provider === "string" && typeof stage.command === "string",
    );
  const caller = record?.caller;
  const callerValid =
    caller === undefined ||
    (Boolean(caller) &&
      (caller.agentId === undefined || typeof caller.agentId === "string") &&
      isStringArray(caller.authority));
  if (!record || record.version !== 1 || !stagesValid || !callerValid) {
    throw new Error(`lobster checkpoint provenance is malformed: ${path.basename(file)}`);
  }
  return record as LobsterCheckpointProvenance;
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
  if (files.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(files[0]), { recursive: true, mode: 0o700 });
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
