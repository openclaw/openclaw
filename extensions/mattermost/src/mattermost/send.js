import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/mattermost";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  createMattermostDirectChannel,
  createMattermostPost,
  fetchMattermostChannelByName,
  fetchMattermostMe,
  fetchMattermostUserByUsername,
  fetchMattermostUserTeams,
  normalizeMattermostBaseUrl,
  uploadMattermostFile
} from "./client.js";
import {
  buildButtonProps,
  resolveInteractionCallbackUrl,
  setInteractionSecret
} from "./interactions.js";
import { isMattermostId, resolveMattermostOpaqueTarget } from "./target-resolution.js";
const botUserCache = /* @__PURE__ */ new Map();
const userByNameCache = /* @__PURE__ */ new Map();
const channelByNameCache = /* @__PURE__ */ new Map();
const dmChannelCache = /* @__PURE__ */ new Map();
const getCore = () => getMattermostRuntime();
function cacheKey(baseUrl, token) {
  return `${baseUrl}::${token}`;
}
function normalizeMessage(text, mediaUrl) {
  const trimmed = text.trim();
  const media = mediaUrl?.trim();
  return [trimmed, media].filter(Boolean).join("\n");
}
function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}
function parseMattermostTarget(raw) {
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
async function resolveBotUser(baseUrl, token) {
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
async function resolveUserIdByUsername(params) {
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
async function resolveChannelIdByName(params) {
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
    }
  }
  throw new Error(`Mattermost channel "#${name}" not found in any team the bot belongs to`);
}
async function resolveTargetChannelId(params) {
  if (params.target.kind === "channel") {
    return params.target.id;
  }
  if (params.target.kind === "channel-name") {
    return await resolveChannelIdByName({
      baseUrl: params.baseUrl,
      token: params.token,
      name: params.target.name
    });
  }
  const userId = params.target.id ? params.target.id : await resolveUserIdByUsername({
    baseUrl: params.baseUrl,
    token: params.token,
    username: params.target.username ?? ""
  });
  const dmKey = `${cacheKey(params.baseUrl, params.token)}::dm::${userId}`;
  const cachedDm = dmChannelCache.get(dmKey);
  if (cachedDm) {
    return cachedDm;
  }
  const botUser = await resolveBotUser(params.baseUrl, params.token);
  const client = createMattermostClient({
    baseUrl: params.baseUrl,
    botToken: params.token
  });
  const channel = await createMattermostDirectChannel(client, [botUser.id, userId]);
  dmChannelCache.set(dmKey, channel.id);
  return channel.id;
}
async function resolveMattermostSendContext(to, opts = {}) {
  const core = getCore();
  const cfg = opts.cfg ?? core.config.loadConfig();
  const account = resolveMattermostAccount({
    cfg,
    accountId: opts.accountId
  });
  const token = opts.botToken?.trim() || account.botToken?.trim();
  if (!token) {
    throw new Error(
      `Mattermost bot token missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.botToken or MATTERMOST_BOT_TOKEN for default).`
    );
  }
  const baseUrl = normalizeMattermostBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Mattermost baseUrl missing for account "${account.accountId}" (set channels.mattermost.accounts.${account.accountId}.baseUrl or MATTERMOST_URL for default).`
    );
  }
  const trimmedTo = to?.trim() ?? "";
  const opaqueTarget = await resolveMattermostOpaqueTarget({
    input: trimmedTo,
    token,
    baseUrl
  });
  const target = opaqueTarget?.kind === "user" ? { kind: "user", id: opaqueTarget.id } : opaqueTarget?.kind === "channel" ? { kind: "channel", id: opaqueTarget.id } : parseMattermostTarget(trimmedTo);
  const channelId = await resolveTargetChannelId({
    target,
    baseUrl,
    token
  });
  return {
    cfg,
    accountId: account.accountId,
    token,
    baseUrl,
    channelId
  };
}
async function resolveMattermostSendChannelId(to, opts = {}) {
  return (await resolveMattermostSendContext(to, opts)).channelId;
}
async function sendMessageMattermost(to, text, opts = {}) {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "mattermost" });
  const { cfg, accountId, token, baseUrl, channelId } = await resolveMattermostSendContext(
    to,
    opts
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
          accountId
        }).config?.interactions
      }),
      accountId,
      channelId,
      buttons: opts.buttons,
      text: opts.attachmentText
    });
  }
  let message = text?.trim() ?? "";
  let fileIds;
  let uploadError;
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await loadOutboundMediaFromUrl(mediaUrl, {
        mediaLocalRoots: opts.mediaLocalRoots
      });
      const fileInfo = await uploadMattermostFile(client, {
        channelId,
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? void 0
      });
      fileIds = [fileInfo.id];
    } catch (err) {
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `mattermost send: media upload failed, falling back to URL text: ${String(err)}`
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }
  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "mattermost",
      accountId
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
    props
  });
  core.channel.activity.record({
    channel: "mattermost",
    accountId,
    direction: "outbound"
  });
  return {
    messageId: post.id ?? "unknown",
    channelId
  };
}
export {
  parseMattermostTarget,
  resolveMattermostSendChannelId,
  sendMessageMattermost
};
