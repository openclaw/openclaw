import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { listEnabledSimplexAccounts, resolveSimplexAccount } from "./accounts.js";
import {
  buildDeleteChatItemCommand,
  buildAddGroupMemberCommand,
  buildReactionCommand,
  buildRemoveGroupMemberCommand,
  buildUpdateChatItemCommand,
  buildUpdateGroupProfileCommand,
  buildLeaveGroupCommand,
  type SimplexComposedMessage,
} from "./simplex-commands.js";
import { buildComposedMessages } from "./simplex-media.js";
import { SimplexWsClient } from "./simplex-ws-client.js";
import type { ResolvedSimplexAccount } from "./types.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type SimplexActionParams = Record<string, unknown>;

type DeleteMode = "broadcast" | "internal" | "internalMark";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  "react",
  "edit",
  "delete",
  "unsend",
  "renameGroup",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
]);

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function readStringParam(
  params: SimplexActionParams,
  key: string,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const value = raw.trim();
  if (!value && !options.allowEmpty) {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  return value;
}

function readNumberParam(
  params: SimplexActionParams,
  key: string,
  options: { required?: boolean; integer?: boolean } = {},
): number | undefined {
  const raw = params[key];
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }
  }
  if (value === undefined) {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  return options.integer ? Math.trunc(value) : value;
}

function normalizeSimplexChatRef(raw: string, chatType?: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutPrefix = trimmed.toLowerCase().startsWith("simplex:")
    ? trimmed.slice("simplex:".length).trim()
    : trimmed;
  if (!withoutPrefix) {
    return withoutPrefix;
  }
  if (withoutPrefix.startsWith("@") || withoutPrefix.startsWith("#")) {
    return withoutPrefix;
  }
  const lowered = withoutPrefix.toLowerCase();
  if (lowered.startsWith("group:")) {
    const id = withoutPrefix.slice("group:".length).trim();
    return id ? `#${id}` : withoutPrefix;
  }
  if (
    lowered.startsWith("contact:") ||
    lowered.startsWith("user:") ||
    lowered.startsWith("member:")
  ) {
    const id = withoutPrefix.slice(withoutPrefix.indexOf(":") + 1).trim();
    return id ? `@${id}` : withoutPrefix;
  }
  if (chatType === "group") {
    return `#${withoutPrefix}`;
  }
  if (chatType === "direct") {
    return `@${withoutPrefix}`;
  }
  return `@${withoutPrefix}`;
}

function normalizeSimplexGroupRef(raw: string): string {
  return normalizeSimplexChatRef(raw, "group");
}

function readChatRef(params: SimplexActionParams): string {
  const raw =
    readStringParam(params, "chatRef") ??
    readStringParam(params, "to") ??
    readStringParam(params, "chatId");
  if (!raw) {
    throw new Error("chatRef or to required");
  }
  const chatType = readStringParam(params, "chatType");
  return normalizeSimplexChatRef(raw, chatType);
}

function readMessageIds(params: SimplexActionParams): Array<number | string> {
  const raw = params.messageIds ?? params.messageId ?? params.chatItemId;
  if (Array.isArray(raw)) {
    const ids = raw
      .map((entry) => (typeof entry === "number" ? entry : String(entry).trim()))
      .filter((entry) => (typeof entry === "number" ? Number.isFinite(entry) : Boolean(entry)));
    if (ids.length > 0) {
      return ids;
    }
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    return [raw];
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      if (trimmed.includes(",")) {
        const parts = trimmed
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
        if (parts.length > 0) {
          return parts;
        }
      }
      return [trimmed];
    }
  }
  throw new Error("messageId or messageIds required");
}

async function withSimplexClient<T>(
  account: ResolvedSimplexAccount,
  fn: (client: SimplexWsClient) => Promise<T>,
): Promise<T> {
  const client = new SimplexWsClient({
    url: account.wsUrl,
    connectTimeoutMs: account.config.connection?.connectTimeoutMs,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function resolveEditMessage(params: {
  cfg: OpenClawConfig;
  account: ResolvedSimplexAccount;
  text: string;
}): Promise<SimplexComposedMessage> {
  const composed = await buildComposedMessages({
    cfg: params.cfg,
    accountId: params.account.accountId,
    text: params.text,
  });
  if (composed.length === 0) {
    throw new Error("text required");
  }
  return composed[0];
}

export const simplexMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledSimplexAccounts(cfg).filter((account) => account.configured);
    if (accounts.length === 0) {
      return [];
    }
    return [
      "send",
      "react",
      "edit",
      "delete",
      "unsend",
      "renameGroup",
      "addParticipant",
      "removeParticipant",
      "leaveGroup",
    ];
  },
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (!SUPPORTED_ACTIONS.has(action)) {
      throw new Error(`Action ${action} not supported for simplex.`);
    }

    const account = resolveSimplexAccount({ cfg, accountId });
    if (!account.enabled) {
      throw new Error("SimpleX account disabled.");
    }
    if (!account.configured) {
      throw new Error("SimpleX account not configured.");
    }

    const chatRef = readChatRef(params);

    if (action === "react") {
      const messageId =
        readNumberParam(params, "messageId", { integer: true }) ??
        readNumberParam(params, "chatItemId", { integer: true });
      if (messageId === undefined) {
        throw new Error("messageId required");
      }
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : false;
      const reaction =
        typeof params.reaction === "object" && params.reaction !== null
          ? (params.reaction as Record<string, unknown>)
          : emoji
            ? { emoji }
            : null;
      if (!reaction) {
        throw new Error("reaction or emoji required");
      }
      const cmd = buildReactionCommand({
        chatRef,
        chatItemId: messageId,
        add: !remove,
        reaction,
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, action: remove ? "removed" : "added", emoji });
    }

    if (action === "edit") {
      const messageId =
        readNumberParam(params, "messageId", { integer: true }) ??
        readNumberParam(params, "chatItemId", { integer: true });
      if (messageId === undefined) {
        throw new Error("messageId required");
      }
      const text =
        readStringParam(params, "text", { allowEmpty: false }) ??
        readStringParam(params, "message", { allowEmpty: false });
      if (!text) {
        throw new Error("text required");
      }
      const updatedMessage = await resolveEditMessage({ cfg, account, text });
      const cmd = buildUpdateChatItemCommand({
        chatRef,
        chatItemId: messageId,
        updatedMessage,
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, updated: messageId });
    }

    if (action === "delete" || action === "unsend") {
      const messageIds = readMessageIds(params);
      const deleteModeRaw = readStringParam(params, "deleteMode");
      const deleteMode =
        deleteModeRaw &&
        (deleteModeRaw === "broadcast" ||
          deleteModeRaw === "internal" ||
          deleteModeRaw === "internalMark")
          ? (deleteModeRaw as DeleteMode)
          : undefined;
      const cmd = buildDeleteChatItemCommand({
        chatRef,
        chatItemIds: messageIds,
        deleteMode,
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, deleted: messageIds });
    }

    if (action === "renameGroup") {
      const target =
        readStringParam(params, "to") ??
        readStringParam(params, "chatRef") ??
        readStringParam(params, "groupId");
      if (!target) {
        throw new Error("groupId or to required");
      }
      const rawProfile =
        readStringParam(params, "profile") ?? readStringParam(params, "groupProfile");
      if (rawProfile) {
        let profile: Record<string, unknown>;
        try {
          profile = JSON.parse(rawProfile) as Record<string, unknown>;
        } catch (err) {
          throw new Error(`Invalid profile JSON: ${String(err)}`, { cause: err });
        }
        const cmd = buildUpdateGroupProfileCommand({
          groupId: normalizeSimplexGroupRef(target),
          profile,
        });
        await withSimplexClient(account, (client) => client.sendCommand(cmd));
        return jsonResult({ ok: true, group: target, profile });
      }
      const displayName =
        readStringParam(params, "displayName") ??
        readStringParam(params, "name") ??
        readStringParam(params, "title");
      if (!displayName) {
        throw new Error("displayName or name required");
      }
      const cmd = buildUpdateGroupProfileCommand({
        groupId: normalizeSimplexGroupRef(target),
        profile: { displayName },
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, group: target, displayName });
    }

    if (action === "addParticipant") {
      const target =
        readStringParam(params, "to") ??
        readStringParam(params, "chatRef") ??
        readStringParam(params, "groupId");
      if (!target) {
        throw new Error("groupId or to required");
      }
      const participant =
        readStringParam(params, "participant") ??
        readStringParam(params, "contactId") ??
        readStringParam(params, "memberId");
      if (!participant) {
        throw new Error("participant or contactId required");
      }
      const cmd = buildAddGroupMemberCommand({
        groupId: normalizeSimplexGroupRef(target),
        contactId: participant,
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, group: target, added: participant });
    }

    if (action === "removeParticipant") {
      const target =
        readStringParam(params, "to") ??
        readStringParam(params, "chatRef") ??
        readStringParam(params, "groupId");
      if (!target) {
        throw new Error("groupId or to required");
      }
      const participant =
        readStringParam(params, "participant") ??
        readStringParam(params, "memberId") ??
        readStringParam(params, "contactId");
      if (!participant) {
        throw new Error("participant or memberId required");
      }
      const cmd = buildRemoveGroupMemberCommand({
        groupId: normalizeSimplexGroupRef(target),
        memberId: participant,
      });
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, group: target, removed: participant });
    }

    if (action === "leaveGroup") {
      const target =
        readStringParam(params, "to") ??
        readStringParam(params, "chatRef") ??
        readStringParam(params, "groupId");
      if (!target) {
        throw new Error("groupId or to required");
      }
      const cmd = buildLeaveGroupCommand(normalizeSimplexGroupRef(target));
      await withSimplexClient(account, (client) => client.sendCommand(cmd));
      return jsonResult({ ok: true, group: target, left: true });
    }

    throw new Error(`Action ${action} not supported for simplex.`);
  },
};
