import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

export type CodexNativeSubagentHistoryOwner = {
  parentThreadId: string;
  sessionId: string;
  lifecycleRevision?: string;
  connectionFingerprint: string;
};

export function codexNativeSubagentHistoryConnectionFingerprint(
  binding: CodexAppServerThreadBinding,
): string | undefined {
  if (!binding.appServerRuntimeFingerprint) {
    return undefined;
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.appServerRuntimeFingerprint,
        binding.connectionScope ?? null,
        binding.authProfileId ?? null,
      ]),
    )
    .digest("hex");
}

export function createCodexNativeSubagentHistoryOwner(params: {
  parentThreadId: string;
  sessionId: string;
  lifecycleRevision?: string;
  binding: CodexAppServerThreadBinding;
}): CodexNativeSubagentHistoryOwner | undefined {
  const connectionFingerprint = codexNativeSubagentHistoryConnectionFingerprint(params.binding);
  return connectionFingerprint
    ? {
        parentThreadId: params.parentThreadId,
        sessionId: params.sessionId,
        ...(params.lifecycleRevision ? { lifecycleRevision: params.lifecycleRevision } : {}),
        connectionFingerprint,
      }
    : undefined;
}

export function readCodexNativeSubagentHistoryOwner(
  detail: unknown,
): CodexNativeSubagentHistoryOwner | undefined {
  const value = asOptionalRecord(detail)?.nativeHistory;
  if (value === undefined) {
    return undefined;
  }
  const owner = asOptionalRecord(value);
  if (
    typeof owner?.parentThreadId !== "string" ||
    !owner.parentThreadId.trim() ||
    typeof owner.sessionId !== "string" ||
    !owner.sessionId.trim() ||
    (owner.lifecycleRevision !== undefined &&
      (typeof owner.lifecycleRevision !== "string" || !owner.lifecycleRevision.trim())) ||
    typeof owner.connectionFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(owner.connectionFingerprint)
  ) {
    throw new Error("Subagent history owner is invalid.");
  }
  return {
    parentThreadId: owner.parentThreadId,
    sessionId: owner.sessionId,
    ...(typeof owner.lifecycleRevision === "string"
      ? { lifecycleRevision: owner.lifecycleRevision }
      : {}),
    connectionFingerprint: owner.connectionFingerprint,
  };
}
