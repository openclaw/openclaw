// Signal alias helpers keep OpenClaw-side names inside the Signal plugin boundary.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";

export type SignalResolvedTargetKind = "user" | "group";

export type ResolvedSignalAliasTarget = {
  to: string;
  kind: SignalResolvedTargetKind;
  alias: string;
};

export type ResolvedSignalTarget =
  | (ResolvedSignalAliasTarget & { source: "alias" })
  | {
      to: string;
      kind: SignalResolvedTargetKind;
      source: "raw";
    };

function normalizeAliasKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutSignal = /^signal:/i.test(trimmed)
    ? trimmed.slice("signal:".length).trim()
    : trimmed;
  const normalized = normalizeLowercaseStringOrEmpty(withoutSignal);
  return normalized || undefined;
}

function resolveAliasMap(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Record<string, string> {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const aliases: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(account.config.aliases ?? {})) {
    const key = normalizeAliasKey(rawKey);
    if (!key) {
      continue;
    }
    aliases[key] = rawValue;
  }
  return aliases;
}

function resolveTargetKind(target: string): SignalResolvedTargetKind {
  return normalizeLowercaseStringOrEmpty(target).startsWith("group:") ? "group" : "user";
}

function normalizeAliasTarget(params: { alias: string; value: string }): {
  to: string;
  kind: SignalResolvedTargetKind;
} {
  const normalized = normalizeSignalMessagingTarget(params.value);
  if (!normalized || !looksLikeSignalTargetId(params.value, normalized)) {
    throw new Error(
      `Signal alias "${params.alias}" must point to an E.164 number, uuid:<id>, username:<name>, or group:<id>.`,
    );
  }
  return {
    to: normalized,
    kind: resolveTargetKind(normalized),
  };
}

export function resolveSignalAliasTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: string;
}): ResolvedSignalAliasTarget | null {
  const aliases = resolveAliasMap(params);
  const initialAlias = normalizeAliasKey(params.input);
  if (!initialAlias || !(initialAlias in aliases)) {
    return null;
  }

  const visited = new Set<string>();
  let alias = initialAlias;
  for (;;) {
    if (visited.has(alias)) {
      throw new Error(`Signal alias "${initialAlias}" resolves recursively through "${alias}".`);
    }
    visited.add(alias);

    const rawValue = aliases[alias];
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`Signal alias "${alias}" must point to a non-empty Signal target.`);
    }

    const nextAlias = normalizeAliasKey(rawValue);
    if (nextAlias && nextAlias in aliases) {
      alias = nextAlias;
      continue;
    }

    return {
      ...normalizeAliasTarget({ alias: initialAlias, value: rawValue }),
      alias: initialAlias,
    };
  }
}

export function resolveSignalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: string;
}): ResolvedSignalTarget | null {
  const aliasTarget = resolveSignalAliasTarget(params);
  if (aliasTarget) {
    return { ...aliasTarget, source: "alias" };
  }
  const normalized = normalizeSignalMessagingTarget(params.input);
  if (!normalized || !looksLikeSignalTargetId(params.input, normalized)) {
    return null;
  }
  return {
    to: normalized,
    kind: resolveTargetKind(normalized),
    source: "raw",
  };
}

export function listSignalAliasDirectoryEntries(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  kind: SignalResolvedTargetKind;
  query?: string | null;
  limit?: number | null;
}): ChannelDirectoryEntry[] {
  const aliases = resolveAliasMap(params);
  const query = normalizeLowercaseStringOrEmpty(params.query);
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const entries: ChannelDirectoryEntry[] = [];
  for (const [alias, value] of Object.entries(aliases)) {
    let target: ReturnType<typeof normalizeAliasTarget>;
    try {
      target = normalizeAliasTarget({ alias, value });
    } catch {
      continue;
    }
    if (target.kind !== params.kind) {
      continue;
    }
    if (
      query &&
      !alias.includes(query) &&
      !normalizeLowercaseStringOrEmpty(target.to).includes(query)
    ) {
      continue;
    }
    entries.push({ kind: params.kind, id: target.to, name: alias });
    if (typeof limit === "number" && entries.length >= limit) {
      break;
    }
  }
  return entries;
}
