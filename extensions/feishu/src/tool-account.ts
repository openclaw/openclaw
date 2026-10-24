import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };
type FeishuToolFamily = keyof FeishuToolsConfig;
type FeishuToolRequirement = {
  family: FeishuToolFamily;
  label: string;
};

type FeishuToolAccountParams = {
  cfg: OpenClawConfig;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
};

function resolveImplicitToolAccountId(params: FeishuToolAccountParams): string {
  const explicitAccountId = normalizeOptionalString(params.executeParams?.accountId);
  if (explicitAccountId) {
    const normalizedAccountId = normalizeOptionalAccountId(explicitAccountId);
    if (!normalizedAccountId) {
      throw new Error(`Invalid Feishu account ID "${explicitAccountId}"`);
    }
    const listedAccountId =
      listFeishuAccountIds(params.cfg).find(
        (accountId) => normalizeOptionalAccountId(accountId) === normalizedAccountId,
      ) ??
      (() => {
        const defaultAccountId = resolveDefaultFeishuAccountId(params.cfg);
        return normalizeOptionalAccountId(defaultAccountId) === normalizedAccountId
          ? defaultAccountId
          : undefined;
      })();
    if (!listedAccountId) {
      throw new Error(`Unknown Feishu account "${explicitAccountId}"`);
    }
    // An explicit alias must stay bound to the exact configured key it
    // matched; resolving with the normalized alias alone can pick up the root
    // account's credentials and tool policy for punctuation-bearing keys.
    const account = resolveFeishuAccount({
      cfg: params.cfg,
      accountId: listedAccountId,
    });
    if (!account.enabled) {
      throw new Error(`Feishu account "${listedAccountId}" is disabled`);
    }
    return listedAccountId;
  }

  const contextualAccountId = normalizeOptionalAccountId(params.defaultAccountId);
  const contextualAccountKey = contextualAccountId
    ? listFeishuAccountIds(params.cfg).find(
        (accountId) => normalizeOptionalAccountId(accountId) === contextualAccountId,
      )
    : undefined;
  if (contextualAccountKey !== undefined) {
    const contextualAccount = resolveFeishuAccount({
      cfg: params.cfg,
      accountId: contextualAccountKey,
    });
    if (contextualAccount.enabled) {
      // Resolve with the exact configured key; a normalized alias can lose
      // punctuation and silently inherit the root account's credentials
      // and tool policy.
      return contextualAccountKey;
    }
  }

  const configuredDefaultAccountId = normalizeOptionalString(
    (params.cfg.channels?.feishu as { defaultAccount?: unknown } | undefined)?.defaultAccount,
  );
  // A routing preference must not reactivate credentials that the operator disabled.
  if (
    configuredDefaultAccountId &&
    resolveFeishuAccount({ cfg: params.cfg, accountId: configuredDefaultAccountId }).enabled
  ) {
    return configuredDefaultAccountId;
  }

  for (const accountId of listFeishuAccountIds(params.cfg)) {
    const account = resolveFeishuAccount({ cfg: params.cfg, accountId });
    if (
      account.enabled &&
      account.configured &&
      resolveToolsConfig(account.config.tools)[params.requiredTool.family]
    ) {
      return accountId;
    }
  }

  throw new Error(`No usable Feishu account has ${params.requiredTool.label} tools enabled`);
}

export function resolveFeishuToolAccount(params: FeishuToolAccountParams): ResolvedFeishuAccount {
  const account = resolveFeishuRuntimeAccount({
    cfg: params.cfg,
    accountId: resolveImplicitToolAccountId(params),
  });
  if (!resolveToolsConfig(account.config.tools)[params.requiredTool.family]) {
    throw new Error(
      `Feishu ${params.requiredTool.label} tools are disabled for account "${account.accountId}"`,
    );
  }
  return account;
}

export function createFeishuToolClient(params: FeishuToolAccountParams): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}
