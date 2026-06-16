import fs from "node:fs/promises";
import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSessionTranscriptRuntimeReadTarget,
  resolveSessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionHeader } from "../sessions/index.js";
import {
  persistTranscriptStateMutation,
  readTranscriptFileState,
  type TranscriptFileState,
  writeTranscriptFileAtomic,
} from "./transcript-file-state.js";

export type RuntimeTranscriptScope = SessionTranscriptRuntimeScope;
export type RuntimeTranscriptTarget = SessionTranscriptRuntimeTarget;

export type RuntimeTranscriptState = {
  state: TranscriptFileState;
  target: RuntimeTranscriptTarget;
};

/**
 * Resolves the current file-backed transcript target for runtime state
 * operations. The returned path is an implementation detail, not identity.
 */
export async function resolveRuntimeTranscriptTarget(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptTarget> {
  return await resolveSessionTranscriptRuntimeTarget(scope);
}

/**
 * Resolves the runtime transcript target for read/probe operations without
 * linking missing file-backed metadata into the session store.
 */
export async function resolveRuntimeTranscriptReadTarget(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptTarget> {
  return await resolveSessionTranscriptRuntimeReadTarget(scope);
}

/**
 * Reads transcript state through the runtime transcript identity contract.
 */
export async function readRuntimeTranscriptState(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptState> {
  const target = await resolveRuntimeTranscriptReadTarget(scope);
  return {
    state: await readTranscriptFileState(target.sessionFile),
    target,
  };
}

/**
 * Persists an append or migration rewrite for a resolved runtime transcript.
 */
export async function persistRuntimeTranscriptStateMutation(params: {
  appendedEntries: SessionEntry[];
  state: TranscriptFileState;
  target: RuntimeTranscriptTarget;
}): Promise<void> {
  await persistTranscriptStateMutation({
    sessionFile: params.target.sessionFile,
    state: params.state,
    appendedEntries: params.appendedEntries,
  });
}

/**
 * Atomically replaces the file-backed transcript for a runtime transcript.
 */
export async function replaceRuntimeTranscriptEntries(params: {
  entries: Array<SessionHeader | SessionEntry>;
  target: RuntimeTranscriptTarget;
}): Promise<void> {
  await writeTranscriptFileAtomic(params.target.sessionFile, params.entries);
}

/**
 * Checks existence of the current runtime transcript without exposing path
 * identity to callers.
 */
export async function runtimeTranscriptExists(scope: RuntimeTranscriptScope): Promise<boolean> {
  const target = await resolveRuntimeTranscriptReadTarget(scope);
  try {
    const stat = await fs.stat(target.sessionFile);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Deletes the current runtime transcript. This remains file-backed until the
 * SQLite implementation owns transcript deletion in 3.2.
 */
export async function deleteRuntimeTranscript(scope: RuntimeTranscriptScope): Promise<boolean> {
  const target = await resolveRuntimeTranscriptReadTarget(scope);
  try {
    await fs.unlink(target.sessionFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
