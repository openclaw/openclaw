import { asOptionalObjectRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveDiscordChannelNameSafe(channel: unknown): string | undefined {
  return readStringField(asOptionalObjectRecord(channel), "name");
}

export function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined {
  return readStringField(asOptionalObjectRecord(channel), "topic");
}

export function resolveDiscordChannelInfoSafe(channel: unknown) {
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
