/** Normalizes ACP runtime memory policy before handle cache and adapter launch. */
import type { AcpRuntimeEnsureInput } from "@openclaw/acp-core/runtime/types";
import { resolveLongTermMemoryRuntimePolicyContext } from "../../sessions/session-memory-policy.js";

export type AcpRuntimeMemoryPolicyContext = NonNullable<AcpRuntimeEnsureInput["memoryPolicy"]>;

function normalizeChatType(
  chatType: AcpRuntimeMemoryPolicyContext["chatType"] | undefined,
): AcpRuntimeMemoryPolicyContext["chatType"] | undefined {
  return chatType === "direct" || chatType === "group" || chatType === "channel"
    ? chatType
    : undefined;
}

function normalizePolicy(
  policy: AcpRuntimeMemoryPolicyContext["longTermMemoryDefaultPolicy"] | undefined,
): AcpRuntimeMemoryPolicyContext["longTermMemoryDefaultPolicy"] | undefined {
  return policy === "include" || policy === "explicit-only" ? policy : undefined;
}

export function normalizeAcpRuntimeMemoryPolicy(
  input: AcpRuntimeEnsureInput["memoryPolicy"] | undefined,
): AcpRuntimeMemoryPolicyContext | undefined {
  const chatType = normalizeChatType(input?.chatType);
  const longTermMemoryDefaultPolicy = normalizePolicy(input?.longTermMemoryDefaultPolicy);
  if (!chatType && !longTermMemoryDefaultPolicy) {
    return undefined;
  }
  return {
    ...(chatType ? { chatType } : {}),
    ...(longTermMemoryDefaultPolicy ? { longTermMemoryDefaultPolicy } : {}),
  };
}

export function resolveAcpRuntimeMemoryPolicy(params: {
  sessionKey: string;
  memoryPolicy?: AcpRuntimeEnsureInput["memoryPolicy"];
}): AcpRuntimeMemoryPolicyContext | undefined {
  const explicitPolicy = normalizeAcpRuntimeMemoryPolicy(params.memoryPolicy);
  if (explicitPolicy) {
    return explicitPolicy;
  }
  const derivedPolicy = resolveLongTermMemoryRuntimePolicyContext({
    sessionKey: params.sessionKey,
    preferStoredPolicy: true,
  });
  return derivedPolicy.longTermMemoryDefaultPolicy === "explicit-only"
    ? derivedPolicy
    : undefined;
}

export function buildAcpRuntimeMemoryPolicySignature(
  input: AcpRuntimeEnsureInput["memoryPolicy"] | undefined,
): string {
  const normalized = normalizeAcpRuntimeMemoryPolicy(input);
  if (!normalized) {
    return "";
  }
  return [normalized.chatType ?? "", normalized.longTermMemoryDefaultPolicy ?? ""].join("|");
}
