import { asOptionalObjectRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";

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
  return readStringField(asOptionalObjectRecord(channel), "name");
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return readStringField(asOptionalObjectRecord(channel), "topic");
}

export function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe {
  const record = asOptionalObjectRecord(channel);
  const raw = asOptionalObjectRecord(record?.rawData);
  const readAlias = (camel: string, snake: string) =>
    readStringField(record, camel) ?? readStringField(record, snake) ?? readStringField(raw, snake);
  return {
    id: readStringField(record, "id"),
    name: readStringField(record, "name"),
    topic: readStringField(record, "topic"),
    type: typeof record?.type === "number" ? record.type : undefined,
    parentId: readAlias("parentId", "parent_id"),
    ownerId: readAlias("ownerId", "owner_id"),
    parentName: readStringField(asOptionalObjectRecord(record?.parent), "name"),
  };
}
