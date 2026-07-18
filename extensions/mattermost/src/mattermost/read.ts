// Mattermost plugin module implements guarded channel-history reads.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { resolveAllowlistProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostChannelPosts,
  type MattermostFetch,
  type MattermostPost,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type ReadContext = Pick<
  ChannelMessageActionContext,
  "conversationReadOrigin" | "requesterAccountId" | "toolContext"
>;

function parseMattermostChannelTarget(rawTarget: string): string | undefined {
  const normalized = normalizeMattermostMessagingTarget(rawTarget);
  if (normalized?.startsWith("channel:")) {
    return normalized.slice("channel:".length).trim() || undefined;
  }
  const trimmed = rawTarget.trim();
  return trimmed && !trimmed.includes(":") ? trimmed : undefined;
}

function isCurrentMattermostReadTarget(params: {
  accountId: string;
  channelId: string;
  context: ReadContext;
}): boolean {
  const toolContext = params.context.toolContext;
  const requesterAccountId = params.context.requesterAccountId?.trim();
  if (
    normalizeLowercaseStringOrEmpty(toolContext?.currentChannelProvider) !== "mattermost" ||
    !requesterAccountId ||
    normalizeAccountId(requesterAccountId) !== normalizeAccountId(params.accountId)
  ) {
    return false;
  }
  const currentTargets = [
    toolContext?.currentChannelId,
    toolContext?.currentMessagingTarget,
  ].filter((target): target is string => typeof target === "string" && Boolean(target.trim()));
  return (
    currentTargets.length > 0 &&
    currentTargets.every(
      (currentTarget) => parseMattermostChannelTarget(currentTarget) === params.channelId,
    )
  );
}

function isConfiguredMattermostReadTarget(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveMattermostAccount>;
  channelId: string;
}): boolean {
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

export async function readMattermostMessages(params: {
  cfg: OpenClawConfig;
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  accountId?: string | null;
  context: ReadContext;
  fetchImpl?: MattermostFetch;
}): Promise<{ messages: MattermostPost[]; hasMore: boolean }> {
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
    fetchImpl: params.fetchImpl,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
  });
  const directOperator = params.context.conversationReadOrigin === "direct-operator";
  const currentConversation = isCurrentMattermostReadTarget({
    accountId: account.accountId,
    channelId: params.channelId,
    context: params.context,
  });
  if (!directOperator && !currentConversation) {
    const requesterAccountId = params.context.requesterAccountId?.trim();
    const sameProvider =
      normalizeLowercaseStringOrEmpty(params.context.toolContext?.currentChannelProvider) ===
      "mattermost";
    const sameAccount =
      requesterAccountId &&
      normalizeAccountId(requesterAccountId) === normalizeAccountId(account.accountId);
    if (!sameProvider || !sameAccount) {
      throw new Error("Mattermost delegated reads require the current Mattermost account.");
    }

    const channel = await fetchMattermostChannel(client, params.channelId);
    if (
      (channel.type !== "O" && channel.type !== "P") ||
      !isConfiguredMattermostReadTarget({ cfg: params.cfg, account, channelId: params.channelId })
    ) {
      throw new Error("Mattermost read target channel is not allowed.");
    }
  }

  return await fetchMattermostChannelPosts(client, params.channelId, {
    limit: params.limit,
    before: params.before,
    after: params.after,
  });
}
