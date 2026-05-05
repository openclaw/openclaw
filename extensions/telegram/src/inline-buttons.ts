import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { TelegramInlineButtonsScope } from "openclaw/plugin-sdk/config-types";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: TelegramInlineButtonsScope = "allowlist";

function normalizeInlineButtonsScope(value: unknown): TelegramInlineButtonsScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed === "off" ||
    trimmed === "dm" ||
    trimmed === "group" ||
    trimmed === "all" ||
    trimmed === "allowlist"
  ) {
    return trimmed as TelegramInlineButtonsScope;
  }
  return undefined;
}

function readInlineButtonsCapability(value: unknown): unknown {
  if (!value || Array.isArray(value) || typeof value !== "object" || !("inlineButtons" in value)) {
    return undefined;
  }
  return value.inlineButtons;
}

export function resolveTelegramInlineButtonsConfigScope(
  capabilities: unknown,
): TelegramInlineButtonsScope | undefined {
  return normalizeInlineButtonsScope(readInlineButtonsCapability(capabilities));
}

export function resolveTelegramInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): TelegramInlineButtonsScope {
  if (!capabilities) {
    return DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  if (Array.isArray(capabilities)) {
    const enabled = capabilities.some(
      (entry) => normalizeLowercaseStringOrEmpty(String(entry)) === "inlinebuttons",
    );
    return enabled ? "all" : "off";
  }
  if (typeof capabilities === "object") {
    return resolveTelegramInlineButtonsConfigScope(capabilities) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
  }
  return DEFAULT_INLINE_BUTTONS_SCOPE;
}

export function resolveTelegramInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope {
  // Embedded prompt prep calls this from raw config before the active runtime
  // snapshot has resolved channel credentials. If channels.telegram.botToken is
  // a non-env SecretRef, `resolveTelegramAccount` throws an unresolved-SecretRef
  // error (#75433). Treat that as "inline buttons disabled for prompt
  // discovery" — return "off" rather than the default "allowlist" so the
  // model never advertises inline-button support when the account hasn't been
  // resolved yet (the runtime send path uses the resolved snapshot, so a real
  // configured account still gets the right capability there). Returning
  // "allowlist" here would prompt the model to generate inline-button payloads
  // even when capabilities.inlineButtons is configured "off".
  let account: ReturnType<typeof resolveTelegramAccount>;
  try {
    account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  } catch (err) {
    if (err instanceof Error && /unresolved SecretRef/i.test(err.message)) {
      return "off";
    }
    throw err;
  }
  return resolveTelegramInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isTelegramInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (params.accountId) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  const accountIds = listTelegramAccountIds(params.cfg);
  if (accountIds.length === 0) {
    return resolveTelegramInlineButtonsScope(params) !== "off";
  }
  return accountIds.some(
    (accountId) => resolveTelegramInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

export { resolveTelegramTargetChatType } from "./targets.js";
