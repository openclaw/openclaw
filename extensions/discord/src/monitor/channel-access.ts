function readDiscordChannelPropertySafe(channel: unknown, key: string): unknown {
  if (!channel || typeof channel !== "object") {
    return undefined;
  }
  try {
    if (!(key in channel)) {
      return undefined;
    }
    return (channel as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function resolveDiscordChannelStringPropertySafe(
  channel: unknown,
  key: string,
): string | undefined {
  const value = readDiscordChannelPropertySafe(channel, key);
  return typeof value === "string" ? value : undefined;
}

function resolveDiscordChannelNumberPropertySafe(
  channel: unknown,
  key: string,
): number | undefined {
  const value = readDiscordChannelPropertySafe(channel, key);
  return typeof value === "number" ? value : undefined;
}

function resolveDiscordChannelStringWithAliasSafe(
  channel: unknown,
  camelKey: string,
  snakeKey: string,
): string | undefined {
  return (
    resolveDiscordChannelStringPropertySafe(channel, camelKey) ??
    resolveDiscordChannelStringPropertySafe(channel, snakeKey) ??
    resolveDiscordChannelStringPropertySafe(
      readDiscordChannelPropertySafe(channel, "rawData"),
      snakeKey,
    )
  );
}

type DiscordChannelInfoSafe = {
  name?: string;
  topic?: string;
  type?: number;
  parentId?: string;
  ownerId?: string;
  parentName?: string;
};

export function resolveDiscordChannelNameSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "name");
}

export function resolveDiscordChannelIdSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "id");
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringPropertySafe(channel, "topic");
}

export function resolveDiscordChannelParentIdSafe(channel: unknown): string | undefined {
  return resolveDiscordChannelStringWithAliasSafe(channel, "parentId", "parent_id");
}

export function resolveDiscordChannelParentSafe(channel: unknown): unknown {
  return readDiscordChannelPropertySafe(channel, "parent");
}

export function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe {
  const parent = resolveDiscordChannelParentSafe(channel);
  return {
    name: resolveDiscordChannelNameSafe(channel),
    topic: resolveDiscordChannelTopicSafe(channel),
    type: resolveDiscordChannelNumberPropertySafe(channel, "type"),
    parentId: resolveDiscordChannelParentIdSafe(channel),
    ownerId: resolveDiscordChannelStringWithAliasSafe(channel, "ownerId", "owner_id"),
    parentName: resolveDiscordChannelNameSafe(parent),
  };
}
