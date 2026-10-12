import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeAcpxRuntimeHandleState, type AcpSessionStore } from "acpx/runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AcpRuntimeHandle, AcpRuntime } from "../runtime-api.js";
import { splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import { readAcpxProcessLeaseIdentity, withAcpxLeaseArgs } from "./process-lease.js";
import {
  readRecordAgentCommand,
  readRecordCwd,
  readRecordResetOnNextEnsure,
  readSessionRecordName,
} from "./runtime-session-store.js";

/** Prepare restoration from the backend's stored facts, never from an idle core state. */
export async function readAcpxSessionRestoration(params: {
  sessionStore: AcpSessionStore;
  sessionKey: string;
  mode: Parameters<AcpRuntime["ensureSession"]>[0]["mode"];
  agent: string;
  cwd: string | undefined;
  defaultCwd: string;
  command: AcpxAgentCommand | undefined;
  resumeSessionId: string | undefined;
  persistedHandle?: AcpRuntimeHandle;
  gatewayInstanceId?: string;
}): Promise<{ reusableCommand?: AcpxAgentCommand; resumeSessionId?: string }> {
  if (!params.command) {
    return {};
  }
  const persisted = params.persistedHandle;
  const decoded = persisted && decodeAcpxRuntimeHandleState(persisted.runtimeSessionName);
  const oneShot = params.mode === "oneshot" && !params.resumeSessionId;
  if (
    oneShot &&
    (!persisted ||
      persisted.backend !== "acpx" ||
      !persisted.acpxRecordId ||
      !decoded ||
      decoded.mode !== "oneshot" ||
      decoded.name !== params.sessionKey ||
      decoded.acpxRecordId !== persisted.acpxRecordId ||
      decoded.agent !== normalizeOptionalLowercaseString(params.agent))
  ) {
    return {};
  }
  if (params.mode !== "persistent" && !oneShot) {
    return {};
  }
  const recordId = oneShot ? persisted?.acpxRecordId : params.sessionKey;
  if (!recordId) {
    return {};
  }
  const record = await params.sessionStore.load(recordId);
  if (!record || readRecordResetOnNextEnsure(record)) {
    return {};
  }
  const cwd = readRecordCwd(record);
  const command = readRecordAgentCommand(record);
  if (
    !cwd ||
    !command ||
    path.resolve(cwd) !== path.resolve(params.cwd?.trim() || params.defaultCwd)
  ) {
    return {};
  }
  const lease = readAcpxProcessLeaseIdentity(command);
  if (
    params.mode === "persistent" &&
    lease &&
    lease.gatewayInstanceId !== params.gatewayInstanceId
  ) {
    return {};
  }
  const expectedCommand = lease
    ? withAcpxLeaseArgs({
        command: params.command,
        leaseId: lease.leaseId,
        gatewayInstanceId: lease.gatewayInstanceId,
      })
    : params.command;
  if (!isDeepStrictEqual(splitCommandParts(command), splitCommandParts(expectedCommand))) {
    return {};
  }
  if (params.mode === "persistent") {
    return !params.resumeSessionId || record.acpSessionId === params.resumeSessionId
      ? { reusableCommand: command }
      : {};
  }
  if (
    record.acpxRecordId !== recordId ||
    readSessionRecordName(record) !== params.sessionKey ||
    record.acpSessionId !== (persisted?.backendSessionId ?? decoded?.backendSessionId) ||
    (!record.agentCapabilities?.loadSession &&
      !record.agentCapabilities?.sessionCapabilities?.resume) ||
    record.lastPromptAt !== undefined ||
    record.messages.some((message) => typeof message !== "string" && "User" in message)
  ) {
    return {};
  }
  // A new Gateway may load the conversation with its own lease, never revive the old one.
  return {
    resumeSessionId: record.acpSessionId,
    ...(!lease || lease.gatewayInstanceId === params.gatewayInstanceId
      ? { reusableCommand: command }
      : {}),
  };
}
