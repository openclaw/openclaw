import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";

export type DiscordReadTargetContext = {
  channelId: string;
  metadataKnown: boolean;
  ancestryComplete: boolean;
  channelType?: number;
  guildId?: string;
  channelName?: string;
  channelSlug: string;
  ancestors: DiscordReadAncestor[];
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: "channel" | "thread";
};

export type DiscordReadAncestor = {
  channelId: string;
  channelName?: string;
  channelSlug: string;
};

export function readDiscordChannelStringField(
  value: unknown,
  ...keys: string[]
): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  // SAFETY: the object guard above excludes primitives and null.
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function readDiscordChannelType(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  // SAFETY: the object guard above excludes primitives and null.
  const type = (value as Record<string, unknown>).type;
  return typeof type === "number" ? type : undefined;
}

export function filterDiscordActiveThreadList(params: {
  value: unknown;
  guildId: string;
  channelId: string;
  parent: DiscordReadTargetContext;
  isAllowed: (target: DiscordReadTargetContext) => boolean;
}): { threads: unknown[]; members: unknown[] } {
  const response = asOptionalRecord(params.value);
  if (!Array.isArray(response?.threads) || !Array.isArray(response.members)) {
    throw new Error("Unexpected Discord response for active thread list.");
  }
  const { guildId, channelId, parent } = params;
  const parentAncestor: DiscordReadAncestor = {
    channelId,
    channelSlug: parent.channelSlug,
    ...(parent.channelName ? { channelName: parent.channelName } : {}),
  };
  const threads: unknown[] = [];
  const threadIds = new Set<string>();
  for (const thread of response.threads) {
    const id = readDiscordChannelStringField(thread, "id");
    const parentId = readDiscordChannelStringField(thread, "parent_id");
    const threadGuildId = readDiscordChannelStringField(thread, "guild_id");
    const channelType = readDiscordChannelType(thread);
    if (
      !id ||
      parentId !== channelId ||
      threadGuildId !== guildId ||
      !isDiscordThreadChannelType(channelType)
    ) {
      continue;
    }
    const channelName = readDiscordChannelStringField(thread, "name");
    const target: DiscordReadTargetContext = {
      channelId: id,
      channelSlug: channelName ? normalizeDiscordSlug(channelName) : id,
      guildId,
      metadataKnown: true,
      ancestryComplete: parent.ancestryComplete,
      ancestors: [parentAncestor, ...parent.ancestors],
      channelType,
      scope: "thread",
      parentId: channelId,
      parentSlug: parent.channelSlug,
      ...(channelName ? { channelName } : {}),
      ...(parent.channelName ? { parentName: parent.channelName } : {}),
    };
    if (!params.isAllowed(target)) {
      continue;
    }
    threads.push(thread);
    threadIds.add(id);
  }
  const members = response.members.filter((member) => {
    const id = readDiscordChannelStringField(member, "id");
    return id !== undefined && threadIds.has(id);
  });
  return { threads, members };
}
