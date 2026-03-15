import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };

function normalizeOptionalAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readConfiguredDefaultAccountId(config: OpenClawPluginApi["config"]): string | undefined {
  const value = (config?.channels?.feishu as { defaultAccount?: unknown } | undefined)
    ?.defaultAccount;
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalAccountId(value);
}

function shouldAutoBindAgent(config: OpenClawPluginApi["config"]): boolean {
  return (
    (config.channels?.feishu as { autoBindAgentAccount?: boolean } | undefined)
      ?.autoBindAgentAccount ?? true
  );
}

function getAgentBindingAccountId(
  config: OpenClawPluginApi["config"],
  agentId?: string,
): string | undefined {
  if (!agentId) return undefined;
  const bindings = config.bindings as
    | Array<{
        agentId: string;
        match: { channel: string; accountId?: string };
      }>
    | undefined;
  const boundAccountId = bindings?.find(
    (b) => b.agentId === agentId && b.match?.channel === "feishu" && b.match?.accountId,
  )?.match?.accountId;
  return normalizeOptionalAccountId(boundAccountId);
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  agentId?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }

  const accountId =
    normalizeOptionalAccountId(params.executeParams?.accountId) ||
    (shouldAutoBindAgent(params.api.config) &&
      getAgentBindingAccountId(params.api.config, params.agentId)) ||
    readConfiguredDefaultAccountId(params.api.config) ||
    normalizeOptionalAccountId(params.defaultAccountId);

  return resolveFeishuAccount({
    cfg: params.api.config,
    accountId,
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  agentId?: string;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}

export function resolveAnyEnabledFeishuToolsConfig(
  accounts: ResolvedFeishuAccount[],
): Required<FeishuToolsConfig> {
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
  }
  return merged;
}
