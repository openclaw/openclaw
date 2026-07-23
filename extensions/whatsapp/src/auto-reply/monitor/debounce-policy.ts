import { resolveAccountEntry } from "openclaw/plugin-sdk/account-core";
import { normalizeWebInboundMessage } from "../../inbound/message-aliases.js";
import type { WebInboundMessageInput } from "../../inbound/types.js";
import { getRuntimeConfig } from "../config.runtime.js";

function normalizeReconnectAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
}

export function resolveExplicitWhatsAppDebounceOverride(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  sourceCfg?: ReturnType<typeof getRuntimeConfig> | null;
  accountId: string;
}): number | undefined {
  const channel = params.sourceCfg?.channels?.whatsapp;
  if (!channel) {
    return undefined;
  }

  const accountId = normalizeReconnectAccountId(params.accountId);
  const accountDebounce = resolveAccountEntry(channel.accounts, accountId)?.debounceMs;
  if (accountDebounce !== undefined) {
    return accountDebounce;
  }
  if (accountId !== "default") {
    const defaultAccountDebounce = resolveAccountEntry(channel.accounts, "default")?.debounceMs;
    if (defaultAccountDebounce !== undefined) {
      return defaultAccountDebounce;
    }
  }

  return channel.debounceMs;
}

type WhatsAppConversationDebounceEntry = {
  debounceMs?: number;
};

function normalizeDebounceMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function resolveWhatsAppScopedDebounceMs(params: {
  entries?: Record<string, WhatsAppConversationDebounceEntry | undefined>;
  id?: string | null;
}): number | undefined {
  const specific = params.id
    ? normalizeDebounceMs(params.entries?.[params.id]?.debounceMs)
    : undefined;
  if (specific !== undefined) {
    return specific;
  }
  return normalizeDebounceMs(params.entries?.["*"]?.debounceMs);
}

export function resolveWhatsAppConversationDebounceMs(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  msg: WebInboundMessageInput;
  defaultMs: number;
}): number {
  const normalized = normalizeWebInboundMessage(params.msg);
  const admission = normalized.admission;
  if (!admission || admission.ingress.decision !== "allow") {
    return params.defaultMs;
  }
  const channel = params.cfg.channels?.whatsapp;
  const scoped =
    admission.conversation.kind === "group"
      ? resolveWhatsAppScopedDebounceMs({
          entries: channel?.groups,
          id: admission.conversation.id,
        })
      : resolveWhatsAppScopedDebounceMs({
          entries: channel?.direct,
          id: admission.conversation.id,
        });
  return scoped ?? params.defaultMs;
}
