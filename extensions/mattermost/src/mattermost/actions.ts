import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { normalizeMattermostMessagingTarget } from "../normalize.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  buildMattermostApiUrl,
  deleteMattermostPost,
  fetchMattermostChannel,
  fetchMattermostUserTeams,
  parseMattermostApiStatus,
  updateMattermostPost,
  type MattermostClient,
} from "./client.js";
import {
  normalizeMattermostMessages,
  postListToMessages,
  type MattermostPostList,
} from "./post-list.js";
import { authorizeMattermostPostForConversation, resolveMattermostBotUserId } from "./reactions.js";
import {
  assertMattermostDelegatedAccount,
  authorizeMattermostChannelRead,
  createMattermostReadClient,
  resolveCurrentMattermostConversation,
  type MattermostReadContext,
} from "./read.js";
import { resolveChannelMediaMaxBytes, type OpenClawConfig } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

type MattermostUserDetails = {
  id: string;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  nickname?: string | null;
  position?: string | null;
  roles?: string | null;
  is_bot?: boolean | null;
  locale?: string | null;
  timezone?: Record<string, unknown> | null;
};

type MattermostChannelDetails = {
  id: string;
  name?: string | null;
  display_name?: string | null;
  type?: string | null;
  team_id?: string | null;
  header?: string | null;
  purpose?: string | null;
  create_at?: number | null;
};

export type MattermostMessageActionParams = {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: MattermostReadContext & { requesterSenderId?: string | null };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
};

function parseChannelTarget(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeMattermostMessagingTarget(trimmed);
  if (normalized?.startsWith("channel:")) {
    return normalized.slice("channel:".length).trim() || undefined;
  }
  return trimmed.includes(":") ? undefined : trimmed;
}

function readChannelTarget(params: Record<string, unknown>): string | undefined {
  return parseChannelTarget(
    readStringParam(params, "to") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "target"),
  );
}

function requireChannelTarget(params: Record<string, unknown>, action: string): string {
  const channelId = readChannelTarget(params);
  if (!channelId) {
    throw new Error(`Mattermost ${action} requires a channel target (target, to, or channelId).`);
  }
  return channelId;
}

function requirePostId(params: Record<string, unknown>, action: string): string {
  const postId =
    normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
  if (!postId) {
    throw new Error(`Mattermost ${action} requires messageId (post id)`);
  }
  return postId;
}

// Mattermost's `in:` search operator (optionally negated) selects channels; a
// delegated caller must not widen or shift the scope the runner authorized.
const MATTERMOST_CHANNEL_SEARCH_OPERATOR = /(^|\s)-?in:/i;

/** A delegated member lookup answers only for members of the current conversation. */
async function assertMattermostConversationMember(params: {
  client: MattermostClient;
  context: MattermostReadContext;
  userId: string;
}): Promise<void> {
  const current = resolveCurrentMattermostConversation(params.context);
  if (!current) {
    throw new Error("Mattermost delegated member info requires a current conversation.");
  }
  const denied = () =>
    new Error(
      "Mattermost delegated member info is limited to members of the current conversation.",
    );
  if (current.kind === "user") {
    if (current.id !== params.userId) {
      throw denied();
    }
    return;
  }
  try {
    await params.client.request<unknown>(
      `/channels/${encodeURIComponent(current.id)}/members/${encodeURIComponent(params.userId)}`,
    );
  } catch (error) {
    if (parseMattermostApiStatus(error) === 404) {
      throw denied();
    }
    throw error;
  }
}

export async function runMattermostMessageAction(
  input: MattermostMessageActionParams,
): Promise<ReturnType<typeof jsonResult>> {
  const { action, params, cfg, context } = input;
  // The host-owned caller check runs here and again inside the client before every
  // provider request, so a revoked caller never reaches Mattermost.
  const assertCallerCurrent = context.assertDirectAdapterHandoff;
  assertCallerCurrent?.();
  const { account, client } = createMattermostReadClient({
    cfg,
    accountId: input.accountId,
    assertRequestCurrent: assertCallerCurrent,
  });
  const cacheKey = `${client.baseUrl}:${client.token}`;
  const delegated = context.conversationReadOrigin !== "direct-operator";
  // The runner preserves the caller's spelling in `target` and puts the
  // directory-resolved provider destination in `to` before dispatch.
  const authorizedTarget = normalizeOptionalString(params.to);
  const authorizePost = async (postId: string, label: string) =>
    delegated
      ? await authorizeMattermostPostForConversation({
          client,
          postId,
          authorizedTarget,
          cacheKey,
          label,
        })
      : undefined;
  const authorizeChannel = (channelId: string) =>
    authorizeMattermostChannelRead({ cfg, account, client, channelId, context });
  const assertAccount = () => assertMattermostDelegatedAccount({ account, context });

  switch (action) {
    case "edit": {
      const postId = requirePostId(params, "edit");
      const message =
        readStringParam(params, "message", { allowEmpty: true }) ??
        readStringParam(params, "text", { allowEmpty: true });
      if (!message?.trim()) {
        throw new Error("Mattermost edit requires message text.");
      }
      await authorizePost(postId, "edit");
      const updated = await updateMattermostPost(client, postId, { message });
      return jsonResult({ ok: true, messageId: updated.id ?? postId, content: message });
    }
    case "delete": {
      const postId = requirePostId(params, "delete");
      await authorizePost(postId, "delete");
      await deleteMattermostPost(client, postId);
      return textResult(`Deleted post ${postId}`, {});
    }
    case "pin":
    case "unpin": {
      const postId = requirePostId(params, action);
      await authorizePost(postId, action);
      await client.request<void>(`/posts/${encodeURIComponent(postId)}/${action}`, {
        method: "POST",
        discardResponse: true,
      });
      return textResult(`${action === "pin" ? "Pinned" : "Unpinned"} post ${postId}`, {});
    }
    case "list-pins": {
      const channelId = requireChannelTarget(params, "list-pins");
      await authorizeChannel(channelId);
      const list = await client.request<MattermostPostList>(
        `/channels/${encodeURIComponent(channelId)}/pinned`,
      );
      return jsonResult({
        ok: true,
        channelId,
        pins: await normalizeMattermostMessages(client, postListToMessages(list)),
      });
    }
    case "search": {
      const terms = readStringParam(params, "query") ?? readStringParam(params, "terms");
      if (!terms) {
        throw new Error("Mattermost search requires query.");
      }
      const limit = readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      });
      const channelId = readChannelTarget(params);
      if (delegated) {
        if (!channelId) {
          // Team-wide search would leak channels the current conversation cannot read.
          throw new Error("Mattermost delegated search requires a channel target.");
        }
        if (MATTERMOST_CHANNEL_SEARCH_OPERATOR.test(terms)) {
          throw new Error(
            "Mattermost delegated search is scoped to the authorized channel; remove in: operators from query.",
          );
        }
      }
      let teamId: string | undefined;
      let scopedTerms = terms;
      if (channelId) {
        await authorizeChannel(channelId);
        const channel = await fetchMattermostChannel(client, channelId);
        teamId = normalizeOptionalString(channel.team_id);
        const channelName = normalizeOptionalString(channel.name);
        if (channelName) {
          scopedTerms = `in:${channelName} ${terms}`;
        } else if (delegated) {
          throw new Error("Mattermost search could not scope the authorized channel.");
        }
      }
      if (!teamId) {
        const botUserId = await resolveMattermostBotUserId(client, cacheKey);
        const teams = botUserId ? await fetchMattermostUserTeams(client, botUserId) : [];
        teamId = teams[0]?.id;
      }
      if (!teamId) {
        throw new Error("Mattermost search could not resolve a team for the bot.");
      }
      const list = await client.request<MattermostPostList>(
        `/teams/${encodeURIComponent(teamId)}/posts/search`,
        {
          method: "POST",
          body: JSON.stringify({
            terms: scopedTerms,
            is_or_search: false,
            page: 0,
            per_page: Math.min(limit ?? 20, 100),
          }),
        },
      );
      // The server scopes by name; the id filter keeps a renamed or ambiguous
      // channel from returning posts the caller was not authorized to read.
      const messages = postListToMessages(list).filter(
        (post) => !channelId || post.channel_id === channelId,
      );
      return jsonResult({
        ok: true,
        teamId,
        ...(channelId ? { channelId } : {}),
        query: scopedTerms,
        messages: await normalizeMattermostMessages(client, messages),
      });
    }
    case "member-info": {
      assertAccount();
      const requesterUserId = delegated ? normalizeOptionalString(context.requesterSenderId) : "";
      const userId = readStringParam(params, "userId") ?? requesterUserId;
      if (!userId) {
        throw new Error("member-info requires a userId outside a current Mattermost conversation.");
      }
      if (delegated && userId !== requesterUserId) {
        await assertMattermostConversationMember({ client, context, userId });
      }
      const user = await client.request<MattermostUserDetails>(
        `/users/${encodeURIComponent(userId)}`,
      );
      return jsonResult({
        ok: true,
        user: {
          id: user.id,
          username: user.username ?? undefined,
          displayName:
            [user.first_name, user.last_name].filter(Boolean).join(" ").trim() ||
            user.nickname ||
            undefined,
          nickname: user.nickname ?? undefined,
          position: user.position ?? undefined,
          roles: user.roles ?? undefined,
          isBot: user.is_bot === true,
          locale: user.locale ?? undefined,
        },
      });
    }
    case "channel-info": {
      const channelId = requireChannelTarget(params, "channel-info");
      await authorizeChannel(channelId);
      const [channel, stats] = await Promise.all([
        client.request<MattermostChannelDetails>(`/channels/${encodeURIComponent(channelId)}`),
        client
          .request<{ member_count?: number | null }>(
            `/channels/${encodeURIComponent(channelId)}/stats`,
          )
          .catch(() => undefined),
      ]);
      return jsonResult({
        ok: true,
        channel: {
          id: channel.id,
          name: channel.name ?? undefined,
          displayName: channel.display_name ?? undefined,
          type: channel.type ?? undefined,
          teamId: channel.team_id ?? undefined,
          header: channel.header ?? undefined,
          purpose: channel.purpose ?? undefined,
          memberCount: stats?.member_count ?? undefined,
          createdAt: channel.create_at ?? undefined,
        },
      });
    }
    case "emoji-list": {
      assertAccount();
      const limit = readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      });
      const perPage = Math.min(limit ?? 200, 200);
      const emoji = await client.request<Array<{ id: string; name?: string | null }>>(
        `/emoji?page=0&per_page=${perPage}&sort=name`,
      );
      return jsonResult({
        ok: true,
        emoji: emoji.flatMap((entry) => (entry.name ? [{ id: entry.id, name: entry.name }] : [])),
        note: "Custom emoji only; Mattermost's built-in emoji use their standard short names.",
      });
    }
    case "download-file": {
      const fileId = readStringParam(params, "fileId", { required: true });
      assertAccount();
      const info = await client.request<{
        id: string;
        name?: string | null;
        mime_type?: string | null;
        size?: number | null;
        post_id?: string | null;
        channel_id?: string | null;
      }>(`/files/${encodeURIComponent(fileId)}/info`);
      if (delegated) {
        const postId = normalizeOptionalString(info.post_id);
        const channelId = normalizeOptionalString(info.channel_id);
        if (postId) {
          // A file download names no destination, so the current conversation is the
          // only target the runner can vouch for.
          await authorizeMattermostPostForConversation({
            client,
            postId,
            authorizedTarget:
              authorizedTarget ??
              normalizeOptionalString(context.toolContext?.currentChannelId) ??
              normalizeOptionalString(context.toolContext?.currentMessagingTarget),
            cacheKey,
            label: "download",
          });
        } else if (channelId) {
          await authorizeChannel(channelId);
        } else {
          throw new Error("Mattermost download-file target is not bound to a conversation.");
        }
      }
      const core = getMattermostRuntime();
      const saved = await core.channel.media.saveRemoteMedia({
        url: buildMattermostApiUrl(client.baseUrl, `/files/${encodeURIComponent(fileId)}`),
        // The media owner reruns the caller check right before the file-body request
        // and keeps it active through publication, so a caller revoked after the info
        // lookup never fetches the bytes.
        assertCurrent: assertCallerCurrent,
        requestInit: { headers: { Authorization: `Bearer ${client.token}` } },
        filePathHint: info.name ?? fileId,
        maxBytes: resolveChannelMediaMaxBytes({
          cfg,
          accountId: account.accountId,
          resolveChannelLimitMb: () => account.config.mediaMaxMb,
        }),
        ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
      });
      return jsonResult({
        ok: true,
        fileId,
        path: saved.path,
        fileName: saved.fileName ?? info.name ?? undefined,
        contentType: saved.contentType ?? info.mime_type ?? undefined,
        size: saved.size,
      });
    }
    case "upload-file": {
      const to =
        readStringParam(params, "to") ??
        readStringParam(params, "target") ??
        normalizeOptionalString(context.toolContext?.currentMessagingTarget);
      if (!to) {
        throw new Error("Mattermost upload-file requires a target.");
      }
      const filePath =
        readStringParam(params, "filePath", { trim: false }) ??
        readStringParam(params, "path", { trim: false }) ??
        readStringParam(params, "media", { trim: false }) ??
        readStringParam(params, "mediaUrl", { trim: false });
      if (!filePath) {
        throw new Error("Mattermost upload-file requires filePath, path, media, or mediaUrl.");
      }
      if (delegated) {
        // Uploads land only where a delegated read may look: the current conversation
        // (channel or DM peer) or a channel the operator configured.
        const target = normalizeMattermostMessagingTarget(to);
        if (target?.startsWith("channel:")) {
          await authorizeChannel(target.slice("channel:".length));
        } else if (target?.startsWith("user:")) {
          const currentTarget = normalizeOptionalString(
            context.toolContext?.currentMessagingTarget,
          );
          assertAccount();
          if (!currentTarget || normalizeMattermostMessagingTarget(currentTarget) !== target) {
            throw new Error(
              "Mattermost delegated upload-file to a direct message must target the current conversation.",
            );
          }
        } else {
          throw new Error("Mattermost delegated upload-file requires a channel: or user: target.");
        }
      }
      const threadId =
        readStringParam(params, "threadId") ??
        readStringParam(params, "replyToId") ??
        readStringParam(params, "replyTo");
      const result = await sendMessageMattermost(
        to,
        readStringParam(params, "message", { allowEmpty: true }) ?? "",
        {
          cfg,
          accountId: account.accountId,
          mediaUrl: filePath,
          mediaLocalRoots: input.mediaLocalRoots,
          mediaReadFile: input.mediaReadFile,
          ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          requireMediaUpload: true,
          replyToId: threadId,
          assertDirectAdapterHandoff: assertCallerCurrent,
        },
      );
      return jsonResult({ ok: true, messageId: result.messageId, channelId: result.channelId });
    }
    default:
      throw new Error(`Unsupported Mattermost action: ${action}`);
  }
}
