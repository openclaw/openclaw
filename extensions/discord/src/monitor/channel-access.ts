function channelRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function channelString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type DiscordChannelInfoSafe = {
  id?: string;
  name?: string;
  topic?: string;
  type?: number;
  parentId?: string;
  ownerId?: string;
  parentName?: string;
};

export function resolveDiscordChannelNameSafe(channel: unknown): string | undefined {
  return channelString(channelRecord(channel)?.name);
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return channelString(channelRecord(channel)?.topic);
}

export function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe {
  const record = channelRecord(channel);
  const raw = channelRecord(record?.rawData);
  const readAlias = (camel: string, snake: string) =>
    channelString(record?.[camel]) ?? channelString(record?.[snake]) ?? channelString(raw?.[snake]);
  return {
    id: channelString(record?.id),
    name: channelString(record?.name),
    topic: channelString(record?.topic),
    type: typeof record?.type === "number" ? record.type : undefined,
    parentId: readAlias("parentId", "parent_id"),
    ownerId: readAlias("ownerId", "owner_id"),
    parentName: channelString(channelRecord(record?.parent)?.name),
  };
}
