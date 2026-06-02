import crypto from "node:crypto";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleChatActionParameter, GoogleChatEvent } from "./types.js";

export const GOOGLECHAT_APPROVAL_ACTION = "openclaw.approval";
const GOOGLECHAT_APPROVAL_ACTION_PARAM = "openclaw_action";
const GOOGLECHAT_APPROVAL_TOKEN_PARAM = "token";
const GOOGLECHAT_APPROVAL_ACTION_VALUE = "approval";

export type GoogleChatApprovalCardBinding = {
  token: string;
  accountId: string;
  approvalId: string;
  approvalKind: "exec" | "plugin";
  decision: ExecApprovalDecision;
  allowedDecisions: readonly ExecApprovalDecision[];
  spaceName: string;
  messageName: string;
  threadName?: string | null;
  expiresAtMs: number;
};

const approvalCardBindings = new Map<string, GoogleChatApprovalCardBinding>();
const approvalCardResolvingTokens = new Set<string>();

export type GoogleChatApprovalCardClaim =
  | { kind: "claimed"; binding: GoogleChatApprovalCardBinding }
  | { kind: "missing" }
  | { kind: "in-flight" };

export function createGoogleChatApprovalToken(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function buildGoogleChatApprovalActionParameters(
  token: string,
): GoogleChatActionParameter[] {
  return [
    { key: GOOGLECHAT_APPROVAL_ACTION_PARAM, value: GOOGLECHAT_APPROVAL_ACTION_VALUE },
    { key: GOOGLECHAT_APPROVAL_TOKEN_PARAM, value: token },
  ];
}

function collectEventParameters(event: GoogleChatEvent): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.common?.parameters ?? {})) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }
  for (const [key, value] of Object.entries(event.commonEventObject?.parameters ?? {})) {
    if (typeof value === "string") {
      params[key] = value;
    }
  }
  for (const item of event.action?.parameters ?? []) {
    if (typeof item.key === "string" && typeof item.value === "string") {
      params[item.key] = item.value;
    }
  }
  return params;
}

export function readGoogleChatApprovalActionToken(event: GoogleChatEvent): string | null {
  const params = collectEventParameters(event);
  if (params[GOOGLECHAT_APPROVAL_ACTION_PARAM] !== GOOGLECHAT_APPROVAL_ACTION_VALUE) {
    return null;
  }
  const actionName =
    normalizeOptionalString(event.action?.actionMethodName) ??
    normalizeOptionalString(event.common?.invokedFunction) ??
    normalizeOptionalString(event.commonEventObject?.invokedFunction);
  if (
    actionName &&
    actionName !== GOOGLECHAT_APPROVAL_ACTION &&
    !actionName.startsWith("https://")
  ) {
    return null;
  }
  return normalizeOptionalString(params[GOOGLECHAT_APPROVAL_TOKEN_PARAM]) ?? null;
}

export function registerGoogleChatApprovalCardBinding(
  binding: GoogleChatApprovalCardBinding,
): boolean {
  if (binding.expiresAtMs <= Date.now()) {
    return false;
  }
  approvalCardBindings.set(binding.token, binding);
  return true;
}

export function getGoogleChatApprovalCardBinding(
  token: string,
): GoogleChatApprovalCardBinding | null {
  const binding = approvalCardBindings.get(token);
  if (!binding) {
    return null;
  }
  if (binding.expiresAtMs <= Date.now()) {
    approvalCardBindings.delete(token);
    return null;
  }
  return binding;
}

export function claimGoogleChatApprovalCardBinding(token: string): GoogleChatApprovalCardClaim {
  const binding = getGoogleChatApprovalCardBinding(token);
  if (!binding) {
    return { kind: "missing" };
  }
  if (approvalCardResolvingTokens.has(token)) {
    return { kind: "in-flight" };
  }
  approvalCardResolvingTokens.add(token);
  return { kind: "claimed", binding };
}

export function completeGoogleChatApprovalCardBinding(token: string): void {
  approvalCardResolvingTokens.delete(token);
  approvalCardBindings.delete(token);
}

export function releaseGoogleChatApprovalCardBinding(token: string): void {
  approvalCardResolvingTokens.delete(token);
}

export function unregisterGoogleChatApprovalCardBindings(tokens: readonly string[]): void {
  for (const token of tokens) {
    approvalCardBindings.delete(token);
    approvalCardResolvingTokens.delete(token);
  }
}

export function clearGoogleChatApprovalCardBindingsForTest(): void {
  approvalCardBindings.clear();
  approvalCardResolvingTokens.clear();
}
