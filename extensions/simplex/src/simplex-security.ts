import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeAllowFrom } from "openclaw/plugin-sdk";
import type { ResolvedSimplexAccount } from "./types.js";

export type SimplexAllowlistEntry = {
  kind: "any" | "sender" | "group";
  value: string;
};

function normalizeSimplexId(value: string): string {
  return value.trim().toLowerCase();
}

function stripSimplexPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("simplex:")
    ? trimmed.slice("simplex:".length).trim()
    : trimmed;
}

export function parseSimplexAllowlistEntry(raw: string | number): SimplexAllowlistEntry | null {
  let entry = String(raw).trim();
  if (!entry) {
    return null;
  }
  if (entry === "*") {
    return { kind: "any", value: "*" };
  }
  entry = stripSimplexPrefix(entry);
  if (!entry) {
    return null;
  }
  const lowered = entry.toLowerCase();
  if (entry.startsWith("#")) {
    const value = entry.slice(1);
    return { kind: "group", value: normalizeSimplexId(value) };
  }
  if (lowered.startsWith("group:")) {
    const value = entry.slice("group:".length);
    return { kind: "group", value: normalizeSimplexId(value) };
  }
  if (entry.startsWith("@")) {
    const value = entry.slice(1);
    return { kind: "sender", value: normalizeSimplexId(value) };
  }
  if (
    lowered.startsWith("contact:") ||
    lowered.startsWith("user:") ||
    lowered.startsWith("member:")
  ) {
    const value = entry.slice(entry.indexOf(":") + 1);
    return { kind: "sender", value: normalizeSimplexId(value) };
  }
  return { kind: "sender", value: normalizeSimplexId(entry) };
}

export function resolveSimplexAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  const accountId = params.accountId ?? "default";
  const accountAllow = params.cfg.channels?.simplex?.accounts?.[accountId]?.allowFrom;
  const baseAllow = params.cfg.channels?.simplex?.allowFrom;
  const raw = Array.isArray(accountAllow) ? accountAllow : baseAllow;
  return normalizeAllowFrom(raw ?? []);
}

export function formatSimplexAllowFrom(allowFrom: Array<string | number>): string[] {
  return normalizeAllowFrom(allowFrom)
    .map((entry) => stripSimplexPrefix(entry))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
}

export function resolveSimplexDmPolicy(params: {
  cfg: OpenClawConfig;
  account: ResolvedSimplexAccount;
}): { policy: string; allowFrom: string[] } {
  const policy =
    params.account.config.dmPolicy ?? params.cfg.channels?.simplex?.dmPolicy ?? "pairing";
  const allowFrom = resolveSimplexAllowFrom({
    cfg: params.cfg,
    accountId: params.account.accountId,
  });
  return { policy, allowFrom };
}

export function isSimplexAllowlisted(params: {
  allowFrom: Array<string | number>;
  senderId?: string | null;
  groupId?: string | null;
  allowGroupId?: boolean;
}): boolean {
  const allowFrom = params.allowFrom ?? [];
  if (allowFrom.length === 0) {
    return false;
  }
  const senderParsed = params.senderId ? parseSimplexAllowlistEntry(String(params.senderId)) : null;
  const senderKey = senderParsed?.kind === "sender" ? senderParsed.value : "";
  const groupKey = params.groupId ? normalizeSimplexId(String(params.groupId)) : "";

  for (const raw of allowFrom) {
    const entry = parseSimplexAllowlistEntry(raw);
    if (!entry) {
      continue;
    }
    if (entry.kind === "any") {
      return true;
    }
    if (entry.kind === "sender") {
      if (senderKey && entry.value === senderKey) {
        return true;
      }
      continue;
    }
    if (entry.kind === "group" && params.allowGroupId) {
      if (groupKey && entry.value === groupKey) {
        return true;
      }
    }
  }
  return false;
}
