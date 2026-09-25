import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AcpSessionStore } from "acpx/runtime";
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeTurnResultError,
} from "../runtime-api.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import { readAcpxProcessLeaseIdentity, withAcpxLeaseArgs } from "./process-lease.js";
import {
  readRecordAgentCommand,
  readRecordCwd,
  readRecordResetOnNextEnsure,
} from "./runtime-session-store.js";

type RuntimeEnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];

export async function readReusablePersistentSessionCommand(params: {
  sessionStore: Pick<AcpSessionStore, "load">;
  defaultCwd: string;
  gatewayInstanceId: string | undefined;
  sessionKey: string;
  mode: RuntimeEnsureInput["mode"];
  cwd: string | undefined;
  command: AcpxAgentCommand | undefined;
  resumeSessionId: string | undefined;
}): Promise<AcpxAgentCommand | undefined> {
  if (params.mode !== "persistent" || !params.command) {
    return undefined;
  }
  const existing = await params.sessionStore.load(params.sessionKey);
  if (!existing || readRecordResetOnNextEnsure(existing)) {
    return undefined;
  }
  const recordCwd = readRecordCwd(existing);
  if (
    !recordCwd ||
    resolvePath(recordCwd) !== resolvePath(params.cwd?.trim() || params.defaultCwd)
  ) {
    return undefined;
  }
  const recordCommand = readRecordAgentCommand(existing);
  if (!recordCommand) {
    return undefined;
  }
  const leaseIdentity = readAcpxProcessLeaseIdentity(recordCommand);
  if (leaseIdentity && leaseIdentity.gatewayInstanceId !== params.gatewayInstanceId) {
    return undefined;
  }
  const stableRecordCommand = leaseIdentity
    ? withAcpxLeaseArgs({
        command: params.command,
        leaseId: leaseIdentity.leaseId,
        gatewayInstanceId: leaseIdentity.gatewayInstanceId,
      })
    : params.command;
  if (
    !isDeepStrictEqual(splitCommandParts(recordCommand), splitCommandParts(stableRecordCommand))
  ) {
    return undefined;
  }
  return !params.resumeSessionId || existing.acpSessionId === params.resumeSessionId
    ? recordCommand
    : undefined;
}

const MISSING_SESSION_ID_PATTERNS = [
  /^(?:Failed to start session:\s*)?(?:session|thread)\s+["']?([^\s"']+)["']?\s+not found$/i,
  /^(?:Failed to start session:\s*)?(?:(?:session|thread) not found|unknown (?:session|thread)|invalid session identifier):\s*["']?([^\s"']+)["']?$/i,
  /^no rollout found for thread id ["']?([^\s"']+)["']?$/i,
];

function isRequestedResumeTargetNotFound(
  value: unknown,
  resumeSessionId: string,
  depth = 0,
): boolean {
  if (depth > 5) {
    return false;
  }
  if (typeof value === "string") {
    return MISSING_SESSION_ID_PATTERNS.some(
      (pattern) => pattern.exec(value.trim())?.[1] === resumeSessionId,
    );
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: the guard above narrows value to a non-null record; all fields stay optional.
  const record = value as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  if (record.code === -32002) {
    if (record.data && typeof record.data === "object" && "uri" in record.data) {
      // The structured resource is authoritative even if message text names another ID.
      return record.data.uri === resumeSessionId;
    }
    return record.message === `Resource not found: ${resumeSessionId}`;
  }
  if (record.code !== undefined && record.code !== -32602 && record.code !== -32603) {
    return false;
  }
  // Normalization clears core resume metadata, so ignore unqualified text and unrelated fields.
  return [record.message, record.data, record.cause, record.error].some((entry) =>
    isRequestedResumeTargetNotFound(entry, resumeSessionId, depth + 1),
  );
}

export async function withResumeEnsureErrorNormalization<T>(params: {
  input: RuntimeEnsureInput;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    const resumeSessionId = params.input.resumeSessionId?.trim();
    if (!resumeSessionId || !isRequestedResumeTargetNotFound(error, resumeSessionId)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : "resume target not found";
    throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", detail, {
      cause: error,
      detailCode: "SESSION_RESUME_TARGET_NOT_FOUND",
    });
  }
}

/** ACPX's generic resume-required code includes transient failures; require the exact missing ID. */
export function normalizeMissingResumeTargetError<T extends AcpRuntimeTurnResultError>(
  error: T,
  handle: AcpRuntimeHandle,
): T {
  const sessionId = handle.backendSessionId?.trim() || handle.agentSessionId?.trim();
  if (!sessionId || error.detailCode !== "SESSION_RESUME_REQUIRED") {
    return error;
  }
  const prefix = `Persistent ACP session ${sessionId} could not be resumed: `;
  const reason = error.message.slice(prefix.length);
  if (
    !error.message.startsWith(prefix) ||
    (reason !== `Resource not found: ${sessionId}` &&
      !isRequestedResumeTargetNotFound(reason, sessionId))
  ) {
    return error;
  }
  return { ...error, detailCode: "SESSION_RESUME_TARGET_NOT_FOUND", retryable: false };
}

export function prepareResumeSafeSessionInput<T extends RuntimeEnsureInput>(params: {
  input: T;
  markFresh: (sessionKey: string) => void;
}): T {
  const { input } = params;
  if (input.mode !== "oneshot" || !input.resumeSessionId?.trim()) {
    return input;
  }
  // ACPX 0.16 retains oneshot clients, but reconnect still permits creating a new session.
  // Explicit follow-ups need persistent's same-session-only policy until OpenClaw closes them.
  params.markFresh(input.sessionKey);
  return { ...input, mode: "persistent" };
}

export function withSessionResumeCapability<T extends object>(
  handle: T,
  record: unknown,
): T & { sessionResumeSupported?: boolean } {
  let agentCapabilities: unknown;
  if (typeof record === "object" && record !== null) {
    // SAFETY: the guard narrows record to a non-null object; the capability field remains optional.
    agentCapabilities = (record as { agentCapabilities?: unknown }).agentCapabilities;
  }
  if (typeof agentCapabilities !== "object" || agentCapabilities === null) {
    return handle;
  }
  // SAFETY: the guard narrows capabilities to a non-null record; nested fields remain optional.
  const capabilities = agentCapabilities as {
    loadSession?: unknown;
    sessionCapabilities?: { resume?: unknown } | null;
  };
  const resumeCapability = capabilities.sessionCapabilities?.resume;
  return {
    ...handle,
    sessionResumeSupported:
      capabilities.loadSession === true ||
      resumeCapability === true ||
      (typeof resumeCapability === "object" && resumeCapability !== null),
  };
}
