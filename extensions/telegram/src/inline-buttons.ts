import type {
  OpenClawConfig,
  TelegramInlineButtonsScope,
} from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds } from "./accounts.js";

const DEFAULT_INLINE_BUTTONS_SCOPE: TelegramInlineButtonsScope = "allowlist";

const INLINE_BUTTONS_SCOPES = ["off", "dm", "group", "all", "allowlist"] as const;

function normalizeInlineButtonsScope(value: unknown): TelegramInlineButtonsScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return INLINE_BUTTONS_SCOPES.find((scope) => scope === trimmed);
}

export function resolveTelegramInlineButtonsConfigScope(
  capabilities: unknown,
): TelegramInlineButtonsScope | undefined {
  if (
    !capabilities ||
    Array.isArray(capabilities) ||
    typeof capabilities !== "object" ||
    !("inlineButtons" in capabilities)
  ) {
    return undefined;
  }
  return normalizeInlineButtonsScope(capabilities.inlineButtons);
}

export function resolveTelegramInlineButtonsScopeFromCapabilities(
  capabilities: unknown,
): TelegramInlineButtonsScope {
  if (Array.isArray(capabilities) && capabilities.length > 0) {
    const enabled = capabilities.some(
      (entry) => normalizeLowercaseStringOrEmpty(String(entry)) === "inlinebuttons",
    );
    return enabled ? "all" : "off";
  }
  return resolveTelegramInlineButtonsConfigScope(capabilities) ?? DEFAULT_INLINE_BUTTONS_SCOPE;
}

export function resolveTelegramInlineButtonsScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): TelegramInlineButtonsScope {
  const account = inspectTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  return resolveTelegramInlineButtonsScopeFromCapabilities(account.config.capabilities);
}

export function isTelegramInlineButtonsEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const accountIds = params.accountId ? [params.accountId] : listTelegramAccountIds(params.cfg);
  return (accountIds.length > 0 ? accountIds : [params.accountId]).some(
    (accountId) => resolveTelegramInlineButtonsScope({ cfg: params.cfg, accountId }) !== "off",
  );
}

export { resolveTelegramTargetChatType } from "./targets.js";
