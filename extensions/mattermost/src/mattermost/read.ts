import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveAllowlistProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostChannelPosts,
  type MattermostClient,
} from "./client.js";
import { normalizeMattermostMessages } from "./post-list.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type MattermostReadContext = Pick<
  ChannelMessageActionContext,
  "conversationReadOrigin" | "requesterAccountId" | "toolContext" | "assertDirectAdapterHandoff"
>;

type MattermostCurrentConversation = { kind: "channel"; id: string } | { kind: "user"; id: string };

function parseMattermostChannelTarget(rawTarget: string): string | undefined {
  const normalized = normalizeMattermostMessagingTarget(rawTarget);
  if (normalized?.startsWith("channel:")) {
    return normalized.slice("channel:".length).trim() || undefined;
  }
  const trimmed = rawTarget.trim();
  return trimmed && !trimmed.includes(":") ? trimmed : undefined;
}

/**
 * The conversation the runner vouches for. Mattermost DMs route outbound messages
 * via `user:<peerId>`, while the trusted native channel ID remains the exact
 * conversation identity, so the channel ID wins when both are present.
 */
export function resolveCurrentMattermostConversation(
  context: Pick<MattermostReadContext, "toolContext">,
): MattermostCurrentConversation | undefined {
  const nativeChannelId = context.toolContext?.currentChannelId?.trim();
  if (nativeChannelId) {
    const channelId = parseMattermostChannelTarget(nativeChannelId);
    return channelId ? { kind: "channel", id: channelId } : undefined;
  }
  const messagingTarget = context.toolContext?.currentMessagingTarget?.trim();
  if (!messagingTarget) {
    return undefined;
  }
  const normalized = normalizeMattermostMessagingTarget(messagingTarget);
  if (normalized?.startsWith("user:")) {
    const id = normalized.slice("user:".length).trim();
    return id ? { kind: "user", id } : undefined;
  }
  const channelId = parseMattermostChannelTarget(messagingTarget);
  return channelId ? { kind: "channel", id: channelId } : undefined;
}

function isCurrentMattermostReadTarget(params: {
  channelId: string;
  context: MattermostReadContext;
}): boolean {
  const current = resolveCurrentMattermostConversation(params.context);
  return current?.kind === "channel" && current.id === params.channelId;
}

function isConfiguredMattermostReadTarget(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveMattermostAccount>;
  channelId: string;
}): boolean {
  // `account.config` already merges provider-level defaults with the selected
  // named account, so omitted account fields inherit groupPolicy and groups.
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.mattermost !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  if (groupPolicy === "disabled") {
    return false;
  }
  if (groupPolicy === "open") {
    return true;
  }
  const groups = params.account.config.groups;
  return groups?.[params.channelId] !== undefined || groups?.["*"] !== undefined;
}

export function createMattermostReadClient(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  /** Host-owned caller authority, rechecked by the client before every request. */
  assertRequestCurrent?: () => void;
}): { account: ReturnType<typeof resolveMattermostAccount>; client: MattermostClient } {
  const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.enabled) {
    throw new Error(`Mattermost account "${account.accountId}" is disabled`);
  }
  const baseUrl = account.baseUrl?.trim();
  const botToken = account.botToken?.trim();
  if (!baseUrl || !botToken) {
    throw new Error("Mattermost botToken/baseUrl missing.");
  }
  const client = createMattermostClient({
    baseUrl,
    botToken,
    allowPrivateNetwork: account.config.network?.dangerouslyAllowPrivateNetwork === true,
    assertRequestCurrent: params.assertRequestCurrent,
  });
  return { account, client };
}

/**
 * Delegated lookups answer only for the Mattermost account that owns the current
 * conversation; a run on another provider or account gets nothing, not even a
 * provider request.
 */
export function assertMattermostDelegatedAccount(params: {
  account: ReturnType<typeof resolveMattermostAccount>;
  context: MattermostReadContext;
}): void {
  if (params.context.conversationReadOrigin === "direct-operator") {
    return;
  }
  const requesterAccountId = params.context.requesterAccountId?.trim();
  const sameProvider =
    normalizeLowercaseStringOrEmpty(params.context.toolContext?.currentChannelProvider) ===
    "mattermost";
  const sameAccount =
    requesterAccountId &&
    normalizeAccountId(requesterAccountId) === normalizeAccountId(params.account.accountId);
  if (!sameProvider || !sameAccount) {
    throw new Error("Mattermost delegated reads require the current Mattermost account.");
  }
}

/**
 * Delegated reads stay inside the current conversation unless the channel is
 * configured under `groups` (or the group policy is open); operators read anywhere
 * Mattermost lets the bot read.
 */
export async function authorizeMattermostChannelRead(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveMattermostAccount>;
  client: MattermostClient;
  channelId: string;
  context: MattermostReadContext;
}): Promise<void> {
  if (params.context.conversationReadOrigin === "direct-operator") {
    return;
  }
  assertMattermostDelegatedAccount(params);
  if (isCurrentMattermostReadTarget(params)) {
    return;
  }
  // Config decides first so a denied channel never reaches the provider.
  if (!isConfiguredMattermostReadTarget(params)) {
    throw new Error("Mattermost read target channel is not allowed.");
  }
  const channel = await fetchMattermostChannel(params.client, params.channelId);
  if (channel.type !== "O" && channel.type !== "P") {
    throw new Error("Mattermost read target channel is not allowed.");
  }
}

export async function readMattermostMessages(params: {
  cfg: OpenClawConfig;
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  accountId?: string | null;
  context: MattermostReadContext;
}): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  const { account, client } = createMattermostReadClient({
    ...params,
    assertRequestCurrent: params.context.assertDirectAdapterHandoff,
  });
  await authorizeMattermostChannelRead({ ...params, account, client });

  const page = await fetchMattermostChannelPosts(client, params.channelId, {
    limit: params.limit,
    before: params.before,
    after: params.after,
  });
  return {
    messages: await normalizeMattermostMessages(client, page.messages),
    hasMore: page.hasMore,
  };
}
