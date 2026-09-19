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
  type MattermostClient,
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
  const nativeChannelId = toolContext?.currentChannelId;
  if (typeof nativeChannelId === "string" && nativeChannelId.trim()) {
    // Mattermost DMs route outbound messages via `user:<peerId>`, while the
    // trusted native channel ID remains the exact conversation identity.
    return parseMattermostChannelTarget(nativeChannelId) === params.channelId;
  }
  const messagingTarget = toolContext?.currentMessagingTarget;
  return (
    typeof messagingTarget === "string" &&
    Boolean(messagingTarget.trim()) &&
    parseMattermostChannelTarget(messagingTarget) === params.channelId
  );
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

// Posts sharing one `create_at` are all reachable from the same cursor, so the
// candidate page can be exhausted before the requested post appears. Walk at
// most this many pages before giving up rather than paging a whole channel.
const MATTERMOST_EXACT_READ_MAX_PAGES = 25;
const MATTERMOST_EXACT_READ_PAGE_SIZE = 60;

async function readMattermostChannelPost(
  client: MattermostClient,
  channelId: string,
  postId: string,
): Promise<{ messages: MattermostPost[]; hasMore: boolean }> {
  // GET /posts/{id} resolves any post the bot can see, and Mattermost has no
  // channel-scoped single-post endpoint. Channel history cursors only return
  // posts from the authorized channel, so anchor on the next newer post there
  // (or the newest page when none exists): the page below that anchor leads
  // with the requested post's `create_at` group when it belongs to this channel.
  const newer = await fetchMattermostChannelPosts(client, channelId, { after: postId, limit: 1 });
  const anchor = newer.messages[0]?.id;
  const cursor = anchor ? { before: anchor } : {};
  // Mattermost cursors compare `create_at` strictly, so re-anchoring on the
  // oldest post of a page would skip the rest of that post's timestamp group.
  // Page by offset instead, and stop once a page reaches an older timestamp:
  // everything between the anchor and that timestamp has then been inspected.
  let groupCreatedAt: number | undefined;
  for (let page = 0; page < MATTERMOST_EXACT_READ_MAX_PAGES; page += 1) {
    const { messages } = await fetchMattermostChannelPosts(client, channelId, {
      ...cursor,
      limit: MATTERMOST_EXACT_READ_PAGE_SIZE,
      page,
    });
    const post = messages.find((message) => message.id === postId);
    if (post) {
      return { messages: [post], hasMore: false };
    }
    groupCreatedAt ??= messages[0]?.create_at ?? undefined;
    const oldest = messages[messages.length - 1]?.create_at;
    if (
      groupCreatedAt === undefined ||
      oldest == null ||
      oldest < groupCreatedAt ||
      messages.length < MATTERMOST_EXACT_READ_PAGE_SIZE
    ) {
      throw new Error("Mattermost read post was not found in the target channel.");
    }
  }
  throw new Error(
    "Mattermost read post was not found among the posts sharing its channel timestamp.",
  );
}

export async function readMattermostMessages(params: {
  cfg: OpenClawConfig;
  channelId: string;
  limit?: number;
  before?: string;
  after?: string;
  messageId?: string;
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

  if (params.messageId) {
    return await readMattermostChannelPost(client, params.channelId, params.messageId);
  }

  return await fetchMattermostChannelPosts(client, params.channelId, {
    limit: params.limit,
    before: params.before,
    after: params.after,
  });
}
