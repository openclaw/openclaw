import { normalizeGroupActivation } from "openclaw/plugin-sdk/group-activation";
import { loadSessionStore } from "./bot-runtime-api.js";

/**
 * Look up the session-level group activation override for a Feishu group.
 *
 * The shared `/activation` command writes `groupActivation` onto the session
 * entry (`src/auto-reply/reply/commands-session.ts`). The Feishu group
 * admission gate must honor this override so that switching to
 * `/activation mention` immediately requires @-mentions even when the
 * static `mentionRequired` config is `false`. Without this lookup the
 * runtime keeps admitting every group message and the user-visible switch
 * silently has no effect (#50490).
 *
 * Returns `undefined` when the store cannot be read or no override is set;
 * callers should fall back to the config-derived `requireMention`.
 */
export function resolveFeishuGroupActivationOverride(params: {
  storePath: string;
  sessionKey: string;
  onError?: (err: unknown) => void;
}): "mention" | "always" | undefined {
  try {
    const store = loadSessionStore(params.storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    return normalizeGroupActivation(entry?.groupActivation);
  } catch (err) {
    params.onError?.(err);
    return undefined;
  }
}

/**
 * Resolve the effective `requireMention` for a Feishu group message.
 *
 * Precedence (matches Telegram/WhatsApp/QQBot sibling channels):
 *   1. Session `groupActivation` set via `/activation mention|always`.
 *   2. Config `channels.feishu.mentionRequired` (or per-group override).
 *
 * Session "always" forces no mention requirement, "mention" forces it on.
 * Undefined means no session override — fall back to config.
 */
export function applyFeishuGroupActivationOverride(params: {
  configRequireMention: boolean;
  activation: "mention" | "always" | undefined;
}): boolean {
  if (params.activation === "mention") {
    return true;
  }
  if (params.activation === "always") {
    return false;
  }
  return params.configRequireMention;
}
