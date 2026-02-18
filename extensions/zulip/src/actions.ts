import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import { resolveZulipAccount } from "./zulip/accounts.js";
import {
  addZulipReaction,
  createZulipClient,
  createZulipStream,
  deactivateZulipUser,
  deleteZulipMessage,
  deleteZulipStream,
  editZulipMessage,
  fetchZulipMemberInfo,
  fetchZulipMessages,
  fetchZulipServerSettings,
  fetchZulipStreams,
  fetchZulipSubscriptions,
  fetchZulipUserPresence,
  inviteZulipUsersToStream,
  normalizeZulipBaseUrl,
  reactivateZulipUser,
  removeZulipReaction,
  resolveZulipStreamId,
  searchZulipMessages,
  sendZulipPrivateMessage,
  sendZulipStreamMessage,
  subscribeZulipStream,
  updateZulipMessageFlag,
  updateZulipMessageTopic,
  updateZulipRealm,
  updateZulipStream,
} from "./zulip/client.js";

const providerId = "zulip";
const MAX_STRING_LENGTH = 10000;
const SAFE_REALM_SETTINGS = [
  "name",
  "description",
  "default_language",
  "notifications_stream_id",
  "signup_notifications_stream_id",
  "message_retention_days",
];

type StreamTarget = {
  stream: string;
  topic?: string;
};

type SendTarget =
  | { kind: "stream"; stream: string; topic: string }
  | { kind: "user"; email: string };

function resolveZulipClient(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveZulipAccount({ cfg, accountId });
  const apiKey = account.apiKey?.trim();
  const email = account.email?.trim();
  if (!apiKey || !email) {
    throw new Error(
      `Zulip apiKey/email missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.apiKey/email or ZULIP_API_KEY/ZULIP_EMAIL for default).`,
    );
  }
  const baseUrl = normalizeZulipBaseUrl(account.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `Zulip url missing for account "${account.accountId}" (set channels.zulip.accounts.${account.accountId}.url or ZULIP_URL for default).`,
    );
  }
  return {
    account,
    client: createZulipClient({ baseUrl, apiKey, email }),
  };
}

function requireAdminActionsEnabled(account: ReturnType<typeof resolveZulipAccount>): void {
  if (!account.enableAdminActions) {
    throw new Error("Admin actions require enableAdminActions: true in Zulip config");
  }
}

async function requireZulipAdmin(client: ReturnType<typeof createZulipClient>): Promise<void> {
  const me = await fetchZulipMemberInfo(client, "me");
  if (!me.is_admin) {
    throw new Error("Zulip admin privileges are required for this action.");
  }
}

function splitStreamTarget(raw: string): StreamTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Stream is required for Zulip channel actions.");
  }

  const lower = trimmed.toLowerCase();
  let candidate = trimmed;
  if (lower.startsWith("stream:")) {
    candidate = trimmed.slice("stream:".length).trim();
  } else if (trimmed.startsWith("#")) {
    candidate = trimmed.slice(1).trim();
  }

  if (!candidate) {
    throw new Error("Stream name is required for Zulip channel actions.");
  }

  let stream = candidate;
  let topic: string | undefined;
  const topicMatch = /(?:^|\s)topic:\s*(.+)$/i.exec(candidate);
  if (topicMatch) {
    stream = candidate.slice(0, topicMatch.index).trim();
    topic = topicMatch[1].trim();
  } else {
    const sepIndex = candidate.search(/[\/#]/);
    if (sepIndex > -1) {
      stream = candidate.slice(0, sepIndex).trim();
      topic = candidate.slice(sepIndex + 1).trim();
    }
  }

  if (!stream) {
    throw new Error("Stream name is required for Zulip channel actions.");
  }

  assertStringLength(stream, "stream", MAX_STRING_LENGTH);
  if (topic) {
    assertStringLength(topic, "topic", MAX_STRING_LENGTH);
  }

  return { stream, topic: topic || undefined };
}

function parseSendTarget(raw: string): SendTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Zulip sends.");
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("stream:")) {
    const rest = trimmed.slice("stream:".length).trim();
    if (!rest) {
      throw new Error("Stream name is required for Zulip sends.");
    }
    const sepIndex = rest.indexOf(":");
    if (sepIndex === -1) {
      throw new Error("Topic is required for Zulip stream sends.");
    }
    const stream = rest.slice(0, sepIndex).trim();
    const topic = rest.slice(sepIndex + 1).trim();
    if (!stream) {
      throw new Error("Stream name is required for Zulip sends.");
    }
    if (!topic) {
      throw new Error("Topic is required for Zulip stream sends.");
    }
    assertStringLength(stream, "stream", MAX_STRING_LENGTH);
    assertStringLength(topic, "topic", MAX_STRING_LENGTH);
    return { kind: "stream", stream, topic };
  }

  if (lower.startsWith("user:")) {
    const email = trimmed.slice("user:".length).trim();
    if (!email) {
      throw new Error("Email is required for Zulip direct messages.");
    }
    assertStringLength(email, "email", MAX_STRING_LENGTH);
    return { kind: "user", email };
  }

  throw new Error("Invalid Zulip send target; use stream:{stream}:{topic} or user:{email}.");
}

function assertStringLength(value: string, field: string, max = MAX_STRING_LENGTH): void {
  if (value.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer.`);
  }
}

function readMessageId(params: Record<string, unknown>): string {
  const messageId = readStringParam(params, "messageId") ?? readStringParam(params, "id");
  if (messageId) {
    return messageId;
  }
  const numericId =
    readNumberParam(params, "messageId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("messageId is required for Zulip message actions.");
}

function readMessageContent(params: Record<string, unknown>): string {
  const content =
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true }) ??
    readStringParam(params, "newText", { allowEmpty: true });
  if (content === undefined) {
    throw new Error("message content is required for Zulip edit actions.");
  }
  assertStringLength(content, "message", MAX_STRING_LENGTH);
  return content;
}

function readSendMessageContent(params: Record<string, unknown>): string {
  const content =
    readStringParam(params, "message", { allowEmpty: true }) ??
    readStringParam(params, "text", { allowEmpty: true }) ??
    readStringParam(params, "content", { allowEmpty: true }) ??
    readStringParam(params, "newText", { allowEmpty: true });
  if (content === undefined) {
    throw new Error("message content is required for Zulip sends.");
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Zulip message is empty.");
  }
  assertStringLength(trimmed, "message", MAX_STRING_LENGTH);
  return trimmed;
}

const resolvedTopicPrefixes = ["✔", "✅"];

function resolveTopicName(topic: string): { topic: string; alreadyResolved: boolean } {
  const trimmed = topic.trim();
  if (!trimmed) {
    return { topic: trimmed, alreadyResolved: false };
  }
  const alreadyResolved = resolvedTopicPrefixes.some((prefix) => trimmed.startsWith(prefix));
  if (alreadyResolved) {
    return { topic: trimmed, alreadyResolved: true };
  }
  return { topic: `✔ ${trimmed}`, alreadyResolved: false };
}

function parseBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function readBooleanParam(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const parsed = parseBooleanValue(params[key]);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parseStringArrayParam(
  params: Record<string, unknown>,
  key: string,
): Array<string | number> | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) {
    return undefined;
  }
  const raw = params[key];
  if (Array.isArray(raw)) {
    return raw as Array<string | number>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof raw === "number") {
    return [raw];
  }
  return undefined;
}

function readStreamId(params: Record<string, unknown>): string {
  const streamId =
    readStringParam(params, "streamId") ??
    readStringParam(params, "channelId") ??
    readStringParam(params, "id");
  if (streamId) {
    return streamId;
  }
  const numericId =
    readNumberParam(params, "streamId", { integer: true }) ??
    readNumberParam(params, "channelId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("streamId is required for Zulip channel actions.");
}

function readUserIdParam(params: Record<string, unknown>): string {
  const userId =
    readStringParam(params, "userId") ??
    readStringParam(params, "memberId") ??
    readStringParam(params, "id") ??
    readStringParam(params, "user");
  if (userId) {
    return userId;
  }
  const numericId =
    readNumberParam(params, "userId", { integer: true }) ??
    readNumberParam(params, "memberId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("userId is required for Zulip user actions.");
}

function readUserIdOrEmailParam(params: Record<string, unknown>): string {
  const userIdOrEmail =
    readStringParam(params, "userId") ??
    readStringParam(params, "memberId") ??
    readStringParam(params, "id") ??
    readStringParam(params, "user") ??
    readStringParam(params, "email");
  if (userIdOrEmail) {
    return userIdOrEmail;
  }
  const numericId =
    readNumberParam(params, "userId", { integer: true }) ??
    readNumberParam(params, "memberId", { integer: true }) ??
    readNumberParam(params, "id", { integer: true });
  if (typeof numericId === "number") {
    return String(numericId);
  }
  throw new Error("userId or email is required for Zulip presence.");
}

function readRealmUpdateParams(
  params: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const raw = params.settings ?? params.realm ?? params.updates ?? params.update;
  if (raw === undefined) {
    throw new Error("settings are required to update Zulip organization settings.");
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("settings must be a JSON object or key/value map.");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("settings must be a key/value object to update Zulip organization settings.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("settings must include at least one field to update.");
  }
  const updates: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (!SAFE_REALM_SETTINGS.includes(key)) {
      throw new Error(`Unsupported organization setting: ${key}.`);
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (typeof value === "string") {
        assertStringLength(value, key, MAX_STRING_LENGTH);
      }
      updates[key] = value;
      continue;
    }
    throw new Error(`Unsupported setting value for ${key}; expected string, number, or boolean.`);
  }
  return updates;
}

export const zulipMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = [resolveZulipAccount({ cfg })].filter((account) =>
      Boolean(account.apiKey && account.email && account.baseUrl),
    );
    if (accounts.length === 0) {
      return [];
    }
    const actions = new Set<ChannelMessageActionName>([
      "send",
      "read",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "react",
      "edit",
      "delete",
      "search",
      "member-info",
      "pin",
      "unpin",
    ]);
    // TODO: These actions require core SDK changes to MESSAGE_ACTION_TARGET_MODE.
    // Re-enable once the SDK supports plugin-registered action target modes.
    // See: https://github.com/openclaw/openclaw/issues/TBD
    // actions.add("channel-subscribe" as ChannelMessageActionName);
    // actions.add("invite" as ChannelMessageActionName);
    // actions.add("resolve-topic" as ChannelMessageActionName);
    // actions.add("user-presence" as ChannelMessageActionName);
    // actions.add("user-deactivate" as ChannelMessageActionName);
    // actions.add("user-reactivate" as ChannelMessageActionName);
    // actions.add("org-settings" as ChannelMessageActionName);
    // actions.add("org-settings-edit" as ChannelMessageActionName);
    return Array.from(actions);
  },
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "send") {
      return null;
    }
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) {
      return null;
    }
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    const { client, account } = resolveZulipClient(cfg, accountId ?? undefined);

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readSendMessageContent(params);
      const target = parseSendTarget(to);

      if (target.kind === "stream") {
        const result = await sendZulipStreamMessage(client, {
          stream: target.stream,
          topic: target.topic,
          content,
        });
        return jsonResult({ success: true, messageId: result.id });
      }

      const result = await sendZulipPrivateMessage(client, {
        to: [target.email],
        content,
      });
      return jsonResult({ success: true, messageId: result.id });
    }

    if (action === "channel-list") {
      const includeAllPublic =
        params.includeAllPublic === true ||
        params.includePublic === true ||
        params.allPublic === true ||
        params.all === true;
      const subscriptions = await fetchZulipSubscriptions(client, {
        includeAllPublic,
      });
      const publicStreams = includeAllPublic ? await fetchZulipStreams(client) : undefined;
      return jsonResult({
        ok: true,
        subscriptions,
        ...(publicStreams ? { publicStreams } : {}),
      });
    }

    if ((action as string) === "channel-subscribe") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      const result = await subscribeZulipStream(client, target.stream);
      return jsonResult({ ok: true, stream: target.stream, result });
    }

    if (action === "channel-create") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "name") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      const description = readStringParam(params, "description", { allowEmpty: true });
      if (description !== undefined) {
        assertStringLength(description, "description", MAX_STRING_LENGTH);
      }
      const principals =
        parseStringArrayParam(params, "principals") ?? parseStringArrayParam(params, "principal");
      const announce = readBooleanParam(params, "announce");
      const inviteOnly = readBooleanParam(
        params,
        "inviteOnly",
        "invite_only",
        "isPrivate",
        "is_private",
      );
      const isWebPublic = readBooleanParam(params, "isWebPublic", "is_web_public");
      const isDefaultStream = readBooleanParam(
        params,
        "isDefaultStream",
        "is_default_stream",
        "defaultStream",
      );
      const historyPublicToSubscribers = readBooleanParam(
        params,
        "historyPublicToSubscribers",
        "history_public_to_subscribers",
      );
      await createZulipStream(client, {
        name: target.stream,
        description: description ?? undefined,
        principals: principals && principals.length > 0 ? principals : undefined,
        announce,
        inviteOnly,
        isWebPublic,
        isDefaultStream,
        historyPublicToSubscribers,
      });
      return jsonResult({ ok: true, stream: target.stream });
    }

    if (action === "channel-edit") {
      const streamIdOrName = readStreamId(params);
      const description = readStringParam(params, "description", { allowEmpty: true });
      const newName = readStringParam(params, "newName") ?? readStringParam(params, "name");
      if (description !== undefined) {
        assertStringLength(description, "description", MAX_STRING_LENGTH);
      }
      if (newName !== undefined) {
        assertStringLength(newName, "name", MAX_STRING_LENGTH);
      }
      const isPrivate = readBooleanParam(
        params,
        "isPrivate",
        "inviteOnly",
        "invite_only",
        "is_private",
      );
      const isWebPublic = readBooleanParam(params, "isWebPublic", "is_web_public");
      const historyPublicToSubscribers = readBooleanParam(
        params,
        "historyPublicToSubscribers",
        "history_public_to_subscribers",
      );
      const isDefaultStream = readBooleanParam(params, "isDefaultStream", "is_default_stream");

      if (
        description === undefined &&
        newName === undefined &&
        isPrivate === undefined &&
        isWebPublic === undefined &&
        historyPublicToSubscribers === undefined &&
        isDefaultStream === undefined
      ) {
        throw new Error("At least one field is required to update a Zulip channel.");
      }

      // Resolve stream name to ID if necessary
      const streamId = await resolveZulipStreamId(client, streamIdOrName);

      await updateZulipStream(client, {
        streamId,
        description: description ?? undefined,
        newName: newName ?? undefined,
        isPrivate,
        isWebPublic,
        historyPublicToSubscribers,
        isDefaultStream,
      });
      return jsonResult({ ok: true, streamId, ...(newName ? { name: newName } : {}) });
    }

    if (action === "channel-delete") {
      const streamIdOrName = readStreamId(params);
      // Resolve stream name to ID if necessary
      const streamId = await resolveZulipStreamId(client, streamIdOrName);
      await deleteZulipStream(client, streamId);
      return jsonResult({ ok: true, streamId });
    }

    if (action === "member-info") {
      const userId =
        readStringParam(params, "userId") ??
        readStringParam(params, "memberId") ??
        readStringParam(params, "id") ??
        readStringParam(params, "user");
      const user = await fetchZulipMemberInfo(client, userId ?? undefined);
      return jsonResult({ ok: true, user });
    }

    if ((action as string) === "user-presence") {
      const userIdOrEmail = readUserIdOrEmailParam(params);
      const presence = await fetchZulipUserPresence(client, userIdOrEmail);
      return jsonResult({ ok: true, user: userIdOrEmail, presence });
    }

    if ((action as string) === "user-deactivate") {
      requireAdminActionsEnabled(account);
      await requireZulipAdmin(client);
      const userId = readUserIdParam(params);
      await deactivateZulipUser(client, userId);
      return jsonResult({ ok: true, userId, deactivated: true });
    }

    if ((action as string) === "user-reactivate") {
      requireAdminActionsEnabled(account);
      await requireZulipAdmin(client);
      const userId = readUserIdParam(params);
      await reactivateZulipUser(client, userId);
      return jsonResult({ ok: true, userId, reactivated: true });
    }

    if ((action as string) === "org-settings") {
      const settings = await fetchZulipServerSettings(client);
      return jsonResult({ ok: true, settings });
    }

    if ((action as string) === "org-settings-edit") {
      requireAdminActionsEnabled(account);
      await requireZulipAdmin(client);
      const updates = readRealmUpdateParams(params);
      await updateZulipRealm(client, updates);
      return jsonResult({ ok: true, updated: Object.keys(updates) });
    }

    if ((action as string) === "invite") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      let principals =
        parseStringArrayParam(params, "principals") ??
        parseStringArrayParam(params, "principal") ??
        parseStringArrayParam(params, "userIds") ??
        parseStringArrayParam(params, "users");
      // Support comma-separated string for userId param (message tool compat)
      if ((!principals || principals.length === 0) && typeof params.userId === "string") {
        principals = params.userId
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (!principals || principals.length === 0) {
        throw new Error("principals are required to invite Zulip users to a stream.");
      }
      for (const principal of principals) {
        if (typeof principal === "string") {
          assertStringLength(principal, "principal", MAX_STRING_LENGTH);
        }
      }
      await inviteZulipUsersToStream(client, {
        stream: target.stream,
        principals,
      });
      return jsonResult({ ok: true, stream: target.stream, principals });
    }

    if (action === "read") {
      const raw =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to", { required: true });
      const target = splitStreamTarget(raw);
      const limit = readNumberParam(params, "limit", { integer: true });
      const explicitTopic = readStringParam(params, "topic");
      const messages = await fetchZulipMessages(client, {
        stream: target.stream,
        topic: explicitTopic ?? target.topic,
        limit: limit ?? undefined,
      });
      return jsonResult({
        ok: true,
        stream: target.stream,
        ...(explicitTopic || target.topic ? { topic: explicitTopic ?? target.topic } : {}),
        messages,
      });
    }

    if (action === "react") {
      const messageId = readMessageId(params);
      const emojiName =
        readStringParam(params, "emoji") ??
        readStringParam(params, "emojiName") ??
        readStringParam(params, "emoji_name");
      const emojiCode =
        readStringParam(params, "emojiCode") ?? readStringParam(params, "emoji_code");
      const reactionType =
        readStringParam(params, "reactionType") ?? readStringParam(params, "reaction_type");
      const remove = params.remove === true;

      if (!emojiName && !remove) {
        throw new Error("Zulip react requires emoji name unless removing reactions.");
      }

      if (remove) {
        await removeZulipReaction(client, {
          messageId,
          emojiName: emojiName ?? undefined,
          emojiCode: emojiCode ?? undefined,
          reactionType: reactionType ?? undefined,
        });
        return jsonResult({ ok: true, removed: true, messageId, emoji: emojiName ?? null });
      }

      await addZulipReaction(client, {
        messageId,
        emojiName: emojiName ?? "",
        emojiCode: emojiCode ?? undefined,
        reactionType: reactionType ?? undefined,
      });
      return jsonResult({ ok: true, added: emojiName, messageId });
    }

    if (action === "edit") {
      const messageId = readMessageId(params);
      const content = readMessageContent(params);
      await editZulipMessage(client, { messageId, content });
      return jsonResult({ ok: true, edited: messageId });
    }

    if (action === "delete") {
      const messageId = readMessageId(params);
      await deleteZulipMessage(client, { messageId });
      return jsonResult({ ok: true, deleted: messageId });
    }

    if (action === "pin" || action === "unpin") {
      const messageId = readMessageId(params);
      // Convert messageId to integer for API call
      const messageIdInt = parseInt(messageId, 10);
      if (isNaN(messageIdInt)) {
        throw new Error(`Invalid messageId: ${messageId}`);
      }
      await updateZulipMessageFlag(client, {
        messageId: messageIdInt,
        flag: "starred",
        op: action === "pin" ? "add" : "remove",
      });
      return jsonResult({
        ok: true,
        messageId,
        starred: action === "pin",
      });
    }

    if ((action as string) === "resolve-topic") {
      const explicitTopic = readStringParam(params, "topic") ?? readStringParam(params, "subject");
      const rawStream =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to");
      const target = rawStream ? splitStreamTarget(rawStream) : undefined;
      const topic = explicitTopic ?? target?.topic;

      if (!topic) {
        throw new Error("topic is required to resolve a Zulip topic.");
      }

      assertStringLength(topic, "topic", MAX_STRING_LENGTH);
      const { topic: resolvedTopic, alreadyResolved } = resolveTopicName(topic);
      if (alreadyResolved) {
        return jsonResult({ ok: true, topic, resolvedTopic, alreadyResolved: true });
      }

      const messageId = (() => {
        try {
          return readMessageId(params);
        } catch {
          return undefined;
        }
      })();

      let targetMessageId = messageId;
      if (!targetMessageId) {
        if (!target?.stream) {
          throw new Error(
            "stream is required to resolve a Zulip topic when messageId is not provided.",
          );
        }
        const messages = await fetchZulipMessages(client, {
          stream: target.stream,
          topic,
          limit: 1,
        });
        const latest = messages[0];
        if (!latest?.id) {
          throw new Error("No messages found for the specified stream/topic.");
        }
        targetMessageId = String(latest.id);
      }

      await updateZulipMessageTopic(client, {
        messageId: targetMessageId,
        topic: resolvedTopic,
        propagateMode: "change_all",
      });

      return jsonResult({
        ok: true,
        stream: target?.stream,
        topic,
        resolvedTopic,
        messageId: targetMessageId,
      });
    }

    if (action === "search") {
      const query =
        readStringParam(params, "query") ??
        readStringParam(params, "text") ??
        readStringParam(params, "q", { required: true });
      assertStringLength(query, "query", MAX_STRING_LENGTH);
      const rawStream =
        readStringParam(params, "stream") ??
        readStringParam(params, "channelId") ??
        readStringParam(params, "to");
      const explicitTopic = readStringParam(params, "topic");
      const limit = readNumberParam(params, "limit", { integer: true });
      const target = rawStream ? splitStreamTarget(rawStream) : undefined;
      const messages = await searchZulipMessages(client, {
        query,
        stream: target?.stream,
        topic: explicitTopic ?? target?.topic,
        limit: limit ?? undefined,
      });
      return jsonResult({
        ok: true,
        query,
        ...(target?.stream ? { stream: target.stream } : {}),
        ...(explicitTopic || target?.topic ? { topic: explicitTopic ?? target?.topic } : {}),
        messages,
      });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
