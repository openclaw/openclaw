import { loadOutboundMediaFromUrl, type OpenClawConfig } from "openclaw/plugin-sdk/mattermost";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostDirectChannel,
  createMattermostPost,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  fetchMattermostUser,
  fetchMattermostUserByUsername,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  uploadMattermostFile,
  type MattermostUser,
} from "./client.js";
import {
  buildButtonProps,
  resolveInteractionCallbackUrl,
  setInteractionSecret,
  type MattermostInteractiveButtonInput,
} from "./interactions.js";

export type MattermostSendOpts = {
  cfg?: OpenClawConfig;
  botToken?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  replyToId?: string;
  props?: Record<string, unknown>;
  buttons?: Array<unknown>;
  attachmentText?: string;
};

export type MattermostSendResult = {
  messageId: string;
  channelId: string;
};

export type MattermostReplyButtons = Array<
  MattermostInteractiveButtonInput | MattermostInteractiveButtonInput[]
>;

type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

const botUserCache = new Map<string, MattermostUser>();
const userByNameCache = new Map<string, MattermostUser>();
const channelByNameCache = new Map<string, string>();

// Cache for ambiguous, unprefixed IDs:
// - whether an opaque id resolved as a user
// - DM channel ids per user
const userIdResolutionCache = new Map<string, boolean>();
const dmChannelCache = new Map<string, string>();

const getCore = () => getMattermostRuntime();

function cacheKey(baseUrl: string, token: string): string {
  return `${baseUrl}::${token}`;
}

function normalizeMessage(text: string, mediaUrl?: string): string {
  const trimmed = text.trim();
  const media = mediaUrl?.trim();
  return [trimmed, media].filter(Boolean).join("\n");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

/** Returns true when the target has an explicit prefix (user:, channel:, mattermost:, @). */
function isExplicitMattermostTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(channel|user|mattermost):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("@")) {
    return true;
  }
  return false;
}

/**
 * Extract Mattermost HTTP status from an error message.
 * Returns undefined for non-API errors or when parsing fails.
 */
function parseMattermostApiStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const msg = "message" in err ? String((err as { message?: unknown }).message ?? "") : "";
  const m = /Mattermost API (\d{3})\b/.exec(msg);
  if (!m) {
    return undefined;
  }
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : undefined;
}

export function parseMattermostTarget(raw: string): MattermostTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Mattermost sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Mattermost sends");
    }
    if (id.startsWith("#")) {
      const name = id.slice(1).trim();
      if (!name) {
        throw new Error("Channel name is required for Mattermost sends");
      }
      return { kind: "channel-name", name };
    }
    if (!isMattermostId(id)) {
      return { kind: "channel-name", name: id };
    }
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { kind: "user", id };
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Mattermost sends");
    }
    return { kind: "user", username };
  }
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1).trim();
    if (!name) {
      throw new Error("Channel name is required for Mattermost sends");
    }
    return { kind: "channel-name", name };
  }
  if (!isMattermostId(trimmed)) {
    return { kind: "channel-name", name: trimmed };
  }
  return { kind: "channel", id: trimmed };
}

async function resolveBotUser(baseUrl: string, token: string): Promise<MattermostUser> {
  const key = cacheKey(baseUrl, token);
  const cached = botUserCache.get(key);
  if (cached) {
    return cached;
  }
  const client = createMattermostClient({ baseUrl, botToken: token });
  const user = await fetchMattermostMe(client);
  botUserCache.set(key, user);
  return user;
}

async function resolveUserIdByUsername(params: {
  baseUrl: string;
  token: string;
  username: string;
}): Promise<string> {
  const { baseUrl, token, username } = params;
  const key = `${cacheKey(baseUrl, token)}::${username.toLowerCase()}`;
  const cached = userByNameCache.get(key);
  if (cached?.id) {
    return cached.id;
  }
  const client = createMattermostClient({ baseUrl, botToken: token });
  const user = await fetchMattermostUserByUsername(client, username);
  userByNameCache.set(key, user);
  return user.id;
}

async function resolveChannelIdByName(params: {
  baseUrl: string;
  token: string;
  name: string;
}): Promise<string> {
  const { baseUrl, token, name } = params;
  const key = `${cacheKey(baseUrl, token)}::channel::${name.toLowerCase()}`;
  const cached = channelByNameCache.get(key);
  if (cached) {
    return cached;
  }
  const client = createMattermostClient({ baseUrl, botToken: token });
  const me = await fetchMattermostMe(client);
  const teams = await fetchMattermostUserTeams(client, me.id);
  for (const team of teams) {
    try {
      const channel = await fetchMattermostChannelByName(client, team.id, name);
      if (channel?.id) {
        channelByNameCache.set(key, channel.id);
        return channel.id;
      }
    } catch {
      // Channel not found in this team, try next
    }
  }
  throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}

async function resolveTargetChannelId(params: {
  target: MattermostTarget;
  baseUrl: string;
  token: string;
}): Promise<string> {
  if (params.target.kind === "channel") {
    return params.target.id;
  }
  if (params.target.kind === "channel-name") {
    return await resolveChannelIdByName({
      baseUrl: params.baseUrl,
      token: params.token,
      name: params.target.name,
    });
  }
  const userId = params.target.id
    ? params.target.id
    : await resolveUserIdByUsername({
        baseUrl: params.baseUrl,
        token: params.token,
        username: params.target.username ?? "",
      });

  const dmKey = `${cacheKey(params.baseUrl, params.token)}::dm::${userId}`;
  const cachedDm = dmChannelCache.get(dmKey);
  if (cachedDm) {
    return cachedDm;
  }

  const botUser = await resolveBotUser(params.baseUrl, params.token);
  const client = createMattermostClient({
    baseUrl: params.baseUrl,
    botToken: params.token,
  });
  const channel = await createMattermostDirectChannel(client, [botUser.id, userId]);
  dmChannelCache.set(dmKey, channel.id);
  return channel.id;
}

type MattermostSendContext = {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  baseUrl: string;
  channelId: string;
};

async function resolveMattermostSendContext(
  to: string,
  opts: MattermostSendOpts = {},
): Promise<MattermostSendContext> {
  const core = getCore();
  const cfg = opts.cfg ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.botToken?.trim() || account.botToken?.trim();
  if (!token) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`,
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`,
    );
  }

  const trimmedTo = to?.trim() ?? "";

  // User-first resolution for ambiguous, unprefixed 26-char Mattermost IDs.
  // A bare 26-char ID is ambiguous: it could be a user ID or a channel ID.
  // We probe the users API first; on 404 we fall back to treating it as a channel ID.
  // Negative results are only cached for confirmed 404s to avoid poisoning the cache
  // on transient errors (429, 5xx, network failures).
  let target: MattermostTarget;
  if (!isExplicitMattermostTarget(trimmedTo) && isMattermostId(trimmedTo)) {
    const key = `${cacheKey(baseUrl, token)}::isUser::${trimmedTo}`;
    const cachedResolution = userIdResolutionCache.get(key);
    if (cachedResolution === true) {
      target = { kind: "user", id: trimmedTo };
    } else if (cachedResolution === false) {
      target = { kind: "channel", id: trimmedTo };
    } else {
      const client = createMattermostClient({ baseUrl, botToken: token });
      try {
        await fetchMattermostUser(client, trimmedTo);
        userIdResolutionCache.set(key, true);
        target = { kind: "user", id: trimmedTo };
      } catch (err) {
        const status = parseMattermostApiStatus(err);

        // Only cache negative resolution for confirmed not-found.
        // For transient errors (429/5xx/network), avoid poisoning the cache.
        if (status === 404) {
          userIdResolutionCache.set(key, false);
        } else {
          if (core.logging.shouldLogVerbose()) {
            const logger = core.logging.getChildLogger({ module: "mattermost" });
            logger.debug?.(
              `mattermost send: could not resolve ambiguous id as user (status=${status ?? "unknown"}); falling back to channel id`,
            );
          }
        }

        target = { kind: "channel", id: trimmedTo };
      }
    }
  } else {
    target = parseMattermostTarget(trimmedTo);
  }

  const channelId = await resolveTargetChannelId({
    target,
    baseUrl,
    token,
  });

  return {
    cfg,
    accountId: account.accountId,
    token,
    baseUrl,
    channelId,
  };
}

export async function resolveMattermostSendChannelId(
  to: string,
  opts: MattermostSendOpts = {},
): Promise<string> {
  return (await resolveMattermostSendContext(to, opts)).channelId;
}

export async function sendMessageMattermost(
  to: string,
  text: string,
  opts: MattermostSendOpts = {},
): Promise<MattermostSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const { cfg, accountId, token, baseUrl, channelId } = await resolveMattermostSendContext(
    to,
    opts,
  );

  const client = createMattermostClient({ baseUrl, botToken: token });
  let props = opts.props;
  if (!props && Array.isArray(opts.buttons) && opts.buttons.length > 0) {
    setInteractionSecret(accountId, token);
    props = buildButtonProps({
      callbackUrl: resolveInteractionCallbackUrl(accountId, {
        gateway: cfg.gateway,
        interactions: resolveMattermostAccount({
          cfg,
          accountId,
        }).config?.interactions,
      }),
      accountId,
      channelId,
      buttons: opts.buttons,
      text: opts.attachmentText,
    });
  }
  let message = text?.trim() ?? "";
  let fileIds: string[] | undefined;
  let uploadError: Error | undefined;
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        mediaLocalRoots: opts.mediaLocalRoots,
      });
      const fileInfo = await uploadMattermostFile(client, {
        channelId,
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
      });
      fileIds = [fileInfo.id];
    } catch (err) {
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `mattermost send: media upload failed, falling back to URL text: ${String(err)}`,
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  if (!message && (!fileIds || fileIds.length === 0)) {
    if (uploadError) {
      throw new Error(`Mattermost media upload failed: ${uploadError.message}`);
    }
    throw new Error("Mattermost message is empty");
  }

  const post = await createMattermostPost(client, {
    channelId,
    message,
    rootId: opts.replyToId,
    fileIds,
    props,
  });

  core.channel.activity.record({
    channel: "mattermost",
    accountId,
    direction: "outbound",
  });

  return {
    messageId: post.id ?? "unknown",
    channelId,
  };
}
