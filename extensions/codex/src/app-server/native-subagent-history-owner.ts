import { createHash } from "node:crypto";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import type { CodexAppServerThreadBinding } from "./session-binding.js";

const nonBlankString = z.string().refine((value) => Boolean(value.trim()));
const historyOwnerSchema = z.object({
  parentThreadId: nonBlankString,
  sessionId: nonBlankString,
  lifecycleRevision: nonBlankString.optional(),
  connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type CodexNativeSubagentHistoryOwner = z.infer<typeof historyOwnerSchema>;

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
  const owner = historyOwnerSchema.safeParse(value);
  if (!owner.success) {
    throw new Error("Subagent history owner is invalid.");
  }
  const { lifecycleRevision, ...required } = owner.data;
  return lifecycleRevision === undefined ? required : { ...required, lifecycleRevision };
}

export function assertHistoryOwnerMatchesRegistration(
  saved: CodexNativeSubagentHistoryOwner | undefined,
  current: CodexNativeSubagentHistoryOwner | undefined,
  parentThreadId: string,
  requireSaved = false,
): void {
  if (requireSaved && !saved) {
    throw new Error("Subagent completion history owner is missing.");
  }
  if (
    saved &&
    (!current ||
      saved.parentThreadId !== parentThreadId ||
      saved.connectionFingerprint !== current.connectionFingerprint ||
      saved.sessionId !== current.sessionId ||
      saved.lifecycleRevision !== current.lifecycleRevision)
  ) {
    throw new Error("Subagent completion history owner is contradictory.");
  }
}
