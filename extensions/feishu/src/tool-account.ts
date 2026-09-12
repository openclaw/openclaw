// Feishu plugin module implements tool account behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listEnabledFeishuAccounts,
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

function resolveImplicitToolAccountId(params: {
  cfg: OpenClawConfig;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): string {
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
    const account = resolveFeishuAccount({
      cfg: params.cfg,
      accountId: normalizedAccountId,
    });
    if (!account.enabled) {
      throw new Error(`Feishu account "${listedAccountId}" is disabled`);
    }
    return normalizedAccountId;
  }

  const contextualAccountId = normalizeOptionalString(params.defaultAccountId);
  if (contextualAccountId && listFeishuAccountIds(params.cfg).includes(contextualAccountId)) {
    const contextualAccount = resolveFeishuAccount({
      cfg: params.cfg,
      accountId: contextualAccountId,
    });
    if (contextualAccount.enabled) {
      return contextualAccountId;
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

export function resolveFeishuToolAccount(params: {
  cfg: OpenClawConfig;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): ResolvedFeishuAccount {
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

export function createFeishuToolClient(params: {
  cfg: OpenClawConfig;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}

export function resolveAnyEnabledFeishuToolsConfig(
  config: OpenClawConfig,
): Required<FeishuToolsConfig> {
  const accounts = listEnabledFeishuAccounts(config);
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
    bitable: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
    merged.bitable = merged.bitable || cfg.bitable;
  }
  return merged;
}
