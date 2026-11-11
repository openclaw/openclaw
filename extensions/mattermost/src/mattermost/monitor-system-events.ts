import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import { fetchMattermostChannelPosts, type MattermostClient } from "./client.js";
import { resolveMattermostMonitorInboundAccess } from "./monitor-auth.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { parseMattermostPost, type MattermostEventPayload } from "./monitor-websocket.js";

type MattermostChannelDetails = {
  id: string;
  name?: string | null;
  display_name?: string | null;
  type?: string | null;
  team_id?: string | null;
  header?: string | null;
  purpose?: string | null;
};

async function fetchMattermostChannelDetails(
  client: MattermostClient,
  channelId: string,
): Promise<MattermostChannelDetails> {
  return await client.request<MattermostChannelDetails>(
    `/channels/${encodeURIComponent(channelId)}`,
  );
}

/**
 * Joining is room admission at effect time: read the configuration the gateway holds now,
 * not the policy captured when the monitor started. Mattermost gates channels by sender
 * allowlists, not a room allowlist, so the only room-level refusals are a disabled account
 * or a disabled group policy.
 */
function resolveMattermostRoomAllowed(
  core: MattermostMonitorContext["core"],
  accountId: string,
): boolean {
  // SAFETY: config.current() returns the host-validated runtime snapshot; it is only read here.
  const cfg = core.config.current() as OpenClawConfig;
  const account = resolveMattermostAccount({ cfg, accountId });
  const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.mattermost !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  });
  return account.enabled && groupPolicy !== "disabled";
}

/**
 * Edits, deletions and channel membership changes reach the routed session as system
 * events, matching Slack. The bot's own edits (draft previews, button confirmations)
 * and system posts never count; a self-join posts the shared join introduction.
 */
export function createMattermostSystemEventHandler(monitor: MattermostMonitorContext) {
  const { account, botUserId, cfg, core, groupPolicy, pairing, resources, client } = monitor;

  const senderLabel = async (userId: string) =>
    normalizeOptionalString((await resources.resolveUserInfo(userId))?.username) ?? userId;

  const enqueue = async (params: {
    channelId: string;
    senderId: string;
    postId?: string;
    threadRootId?: string;
    eventKind: "message" | "system";
    dropLabel: string;
    describe: (labels: { sender: string; room: string }) => string;
    contextKey: string;
  }) => {
    const senderName = await senderLabel(params.senderId);
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId: params.channelId,
      senderId: params.senderId,
      postId: params.postId,
      threadRootId: params.threadRootId,
      dropLabel: params.dropLabel,
    });
    if (!eventPlan) {
      return;
    }
    const access = await resolveMattermostMonitorInboundAccess({
      account,
      cfg,
      senderId: params.senderId,
      senderName,
      channelId: params.channelId,
      kind: eventPlan.kind,
      groupPolicy,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands: false,
      hasControlCommand: false,
      eventKind: params.eventKind,
      mayPair: false,
    });
    if (access.ingress.decision !== "allow") {
      monitor.logVerboseMessage(
        `mattermost: drop ${params.dropLabel} (sender=${params.senderId} reason=${access.senderAccess.reasonCode} channel=${params.channelId})`,
      );
      return;
    }
    const text = params.describe({ sender: `@${senderName}`, room: eventPlan.roomLabel });
    core.system.enqueueSystemEvent(text, {
      sessionKey: eventPlan.thread.sessionKey,
      contextKey: params.contextKey,
    });
    monitor.logVerboseMessage(`mattermost system event: ${text}`);
  };

  const handlePostChange = async (
    payload: MattermostEventPayload,
    change: "edited" | "deleted",
  ) => {
    const post = parseMattermostPost(payload.data?.post);
    const channelId =
      normalizeOptionalString(post?.channel_id) ??
      normalizeOptionalString(payload.broadcast?.channel_id);
    const senderId = normalizeOptionalString(post?.user_id);
    if (!post || !channelId || !senderId) {
      return;
    }
    // Draft previews are edited and deleted constantly; the bot's own posts are never news.
    if (senderId === botUserId || normalizeOptionalString(post.type) !== undefined) {
      return;
    }
    const rootId = normalizeOptionalString(post.root_id);
    await enqueue({
      channelId,
      senderId,
      postId: post.id,
      threadRootId: rootId,
      eventKind: "message",
      dropLabel: `post ${change}`,
      describe: ({ sender, room }) =>
        change === "edited"
          ? `Mattermost message edited by ${sender} in ${room} (post ${post.id}).`
          : `Mattermost message deleted by ${sender} in ${room} (post ${post.id}).`,
      contextKey: `mattermost:post:${change}:${post.id}:${post.update_at ?? post.delete_at ?? ""}`,
    });
  };

  const introduceBot = async (channelId: string) => {
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId,
      senderId: botUserId,
      dropLabel: "join",
    });
    if (!eventPlan || eventPlan.kind === "direct") {
      return;
    }
    // SAFETY: config.current() returns the host-validated runtime snapshot; it is only read here.
    const currentCfg = core.config.current() as OpenClawConfig;
    const outcome = await reportChannelRoomJoin({
      cfg: currentCfg,
      channel: "mattermost",
      accountId: account.accountId,
      conversationId: channelId,
      deliverTo: `channel:${channelId}`,
      route: { agentId: eventPlan.route.agentId, sessionKey: eventPlan.thread.sessionKey },
      // Introductions arrived after Mattermost shipped: existing installs opt in with joinIntro.
      enabledByDefault: false,
      roomAllowed: () => resolveMattermostRoomAllowed(core, account.accountId),
      resolveRoomContext: async ({ messageLimit }) => {
        const details = await fetchMattermostChannelDetails(client, channelId);
        const purpose = [details.purpose, details.header]
          .map((value) => normalizeOptionalString(value))
          .filter((value): value is string => Boolean(value))
          .join("\n");
        const title = details.display_name
          ? details.display_name
          : details.name
            ? `#${details.name}`
            : undefined;
        try {
          const { messages } = await fetchMattermostChannelPosts(client, channelId, {
            limit: messageLimit,
            skipFetchThreads: true,
          });
          const readable = messages
            .filter((post) => !post.type && normalizeOptionalString(post.message))
            .toReversed();
          const senders = new Map<string, string>();
          for (const post of readable) {
            const userId = normalizeOptionalString(post.user_id);
            if (userId && !senders.has(userId)) {
              senders.set(userId, await senderLabel(userId));
            }
          }
          return {
            title,
            purpose: purpose || undefined,
            recentMessages: readable.map((post) => ({
              sender: senders.get(post.user_id ?? ""),
              text: post.message ?? "",
            })),
          };
        } catch {
          return { title, purpose: purpose || undefined };
        }
      },
    });
    if (outcome.kind === "failed") {
      monitor.runtime.error?.(`mattermost join introduction failed: ${outcome.reason}`);
    }
  };

  const handleMembership = async (payload: MattermostEventPayload, verb: "joined" | "left") => {
    const channelId =
      normalizeOptionalString(payload.broadcast?.channel_id) ??
      normalizeOptionalString(payload.data?.channel_id);
    const userId =
      normalizeOptionalString(payload.data?.user_id) ??
      normalizeOptionalString(payload.broadcast?.user_id);
    if (!channelId || !userId) {
      return;
    }
    if (userId === botUserId) {
      if (verb === "joined") {
        await introduceBot(channelId);
      } else {
        monitor.logVerboseMessage(`mattermost: bot removed from channel ${channelId}`);
      }
      return;
    }
    await enqueue({
      channelId,
      senderId: userId,
      eventKind: "system",
      dropLabel: `member ${verb}`,
      describe: ({ sender, room }) => `Mattermost: ${sender} ${verb} ${room}.`,
      contextKey: `mattermost:member:${verb}:${channelId}:${userId}`,
    });
  };

  return async (payload: MattermostEventPayload) => {
    switch (payload.event) {
      case "post_edited":
        return await handlePostChange(payload, "edited");
      case "post_deleted":
        return await handlePostChange(payload, "deleted");
      case "user_added":
        return await handleMembership(payload, "joined");
      case "user_removed":
        return await handleMembership(payload, "left");
      default:
        return undefined;
    }
  };
}
