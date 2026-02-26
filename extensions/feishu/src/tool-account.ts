import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };

function normalizeOptionalAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuAccount({
    cfg: params.api.config,
    accountId:
      normalizeOptionalAccountId(params.executeParams?.accountId) ??
      normalizeOptionalAccountId(params.defaultAccountId),
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}

export function resolveAnyEnabledFeishuToolsConfig(
  accounts: ResolvedFeishuAccount[],
): Required<FeishuToolsConfig> {
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
  }
  return merged;
}
