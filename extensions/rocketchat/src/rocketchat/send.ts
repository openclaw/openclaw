import { getRocketchatRuntime } from "../runtime.js";
import { resolveRocketchatAccount } from "./accounts.js";
import {
  createRocketchatClient,
  createRocketchatDm,
  fetchRocketchatMe,
  fetchRocketchatUserByUsername,
  normalizeRocketchatBaseUrl,
  sendRocketchatMessage,
  uploadRocketchatFile,
  type RocketchatUser,
} from "./client.js";

export type RocketchatSendOpts = {
  authToken?: string;
  userId?: string;
  baseUrl?: string;
  accountId?: string;
  mediaUrl?: string;
  replyToId?: string;
};

export type RocketchatSendResult = {
  messageId: string;
  roomId: string;
};

type RocketchatTarget =
  | { kind: "channel"; id: string }
  | { kind: "user"; id?: string; username?: string };

const botUserCache = new Map<string, RocketchatUser>();
const userByNameCache = new Map<string, RocketchatUser>();

const getCore = () => getRocketchatRuntime();

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

function parseRocketchatTarget(raw: string): RocketchatTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Rocket.Chat sends");
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Rocket.Chat sends");
    }
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) {
      throw new Error("User id is required for Rocket.Chat sends");
    }
    return { kind: "user", id };
  }
  if (lower.startsWith("rocketchat:")) {
    const id = trimmed.slice("rocketchat:".length).trim();
    if (!id) {
      throw new Error("User id is required for Rocket.Chat sends");
    }
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Rocket.Chat sends");
    }
    return { kind: "user", username };
  }
  return { kind: "channel", id: trimmed };
}

async function resolveBotUser(
  baseUrl: string,
  authToken: string,
  userId: string,
): Promise<RocketchatUser> {
  const key = cacheKey(baseUrl, authToken);
  const cached = botUserCache.get(key);
  if (cached) {
    return cached;
  }
  const client = createRocketchatClient({ baseUrl, authToken, userId });
  const user = await fetchRocketchatMe(client);
  botUserCache.set(key, user);
  return user;
}

async function resolveUserIdByUsername(params: {
  baseUrl: string;
  authToken: string;
  userId: string;
  username: string;
}): Promise<string> {
  const { baseUrl, authToken, userId, username } = params;
  const key = `${cacheKey(baseUrl, authToken)}::${username.toLowerCase()}`;
  const cached = userByNameCache.get(key);
  if (cached?._id) {
    return cached._id;
  }
  const client = createRocketchatClient({ baseUrl, authToken, userId });
  const user = await fetchRocketchatUserByUsername(client, username);
  userByNameCache.set(key, user);
  return user._id;
}

async function resolveTargetRoomId(params: {
  target: RocketchatTarget;
  baseUrl: string;
  authToken: string;
  userId: string;
}): Promise<string> {
  if (params.target.kind === "channel") {
    return params.target.id;
  }
  const targetUsername = params.target.username;
  if (targetUsername) {
    const client = createRocketchatClient({
      baseUrl: params.baseUrl,
      authToken: params.authToken,
      userId: params.userId,
    });
    const dm = await createRocketchatDm(client, [targetUsername]);
    return dm._id;
  }
  // For user IDs, we need to look up username first, then create DM
  const client = createRocketchatClient({
    baseUrl: params.baseUrl,
    authToken: params.authToken,
    userId: params.userId,
  });
  const botUser = await resolveBotUser(params.baseUrl, params.authToken, params.userId);
  const botUsername = botUser.username ?? "";
  // Create DM using the REST endpoint with user IDs
  const data = await client.request<{ room: { _id: string } }>("/dm.create", {
    method: "POST",
    body: JSON.stringify({ usernames: [botUsername, params.target.id].filter(Boolean).join(",") }),
  });
  return data.room._id;
}

export async function sendMessageRocketchat(
  to: string,
  text: string,
  opts: RocketchatSendOpts = {},
): Promise<RocketchatSendResult> {
  const core = getCore();
  const logger = core.logging.getChildLogger({ module: "rocketchat" });
  const cfg = core.config.loadConfig();
  const account = resolveRocketchatAccount({
    cfg,
    accountId: opts.accountId,
  });
  const authToken = opts.authToken?.trim() || account.authToken?.trim();
  if (!authToken) {
    throw new Error(
      `Rocket.Chat auth token missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.authToken or ROCKETCHAT_AUTH_TOKEN for default).`,
    );
  }
  const rcUserId = opts.userId?.trim() || account.userId?.trim();
  if (!rcUserId) {
    throw new Error(
      `Rocket.Chat user ID missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.userId or ROCKETCHAT_USER_ID for default).`,
    );
  }
  const baseUrl = normalizeRocketchatBaseUrl(opts.baseUrl ?? account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Rocket.Chat baseUrl missing for account "${account.accountId}" (set channels.rocketchat.accounts.${account.accountId}.baseUrl or ROCKETCHAT_URL for default).`,
    );
  }

  const target = parseRocketchatTarget(to);
  const roomId = await resolveTargetRoomId({
    target,
    baseUrl,
    authToken,
    userId: rcUserId,
  });

  const client = createRocketchatClient({ baseUrl, authToken, userId: rcUserId });
  let message = text?.trim() ?? "";
  let uploadedMessageId: string | undefined;
  let uploadError: Error | undefined;
  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      const uploaded = await uploadRocketchatFile(client, {
        roomId,
        buffer: media.buffer,
        fileName: media.fileName ?? "upload",
        contentType: media.contentType ?? undefined,
        description: message,
        tmid: opts.replyToId,
      });
      uploadedMessageId = uploaded._id;
    } catch (err) {
      uploadError = err instanceof Error ? err : new Error(String(err));
      if (core.logging.shouldLogVerbose()) {
        logger.debug?.(
          `rocketchat send: media upload failed, falling back to URL text: ${String(err)}`,
        );
      }
      message = normalizeMessage(message, isHttpUrl(mediaUrl) ? mediaUrl : "");
    }
  }

  if (uploadedMessageId) {
    core.channel.activity.record({
      channel: "rocketchat",
      accountId: account.accountId,
      direction: "outbound",
    });
    return { messageId: uploadedMessageId, roomId };
  }

  if (message) {
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "rocketchat",
      accountId: account.accountId,
    });
    message = core.channel.text.convertMarkdownTables(message, tableMode);
  }

  if (!message) {
    if (uploadError) {
      throw new Error(`Rocket.Chat media upload failed: ${uploadError.message}`);
    }
    throw new Error("Rocket.Chat message is empty");
  }

  const posted = await sendRocketchatMessage(client, {
    roomId,
    text: message,
    tmid: opts.replyToId,
  });

  core.channel.activity.record({
    channel: "rocketchat",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: posted._id ?? "unknown",
    roomId,
  };
}
