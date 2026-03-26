import { buildChannelConfigSchema, DiscordConfigSchema } from "./runtime-api.js";

type JsonSchemaNode = Record<string, unknown>;

function asSchemaNode(value: unknown): JsonSchemaNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : undefined;
}

function getSchemaNode(root: unknown, path: readonly string[]): JsonSchemaNode | undefined {
  let current = asSchemaNode(root);
  for (const key of path) {
    current = asSchemaNode(current?.[key]);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

function forceStringArrayItems(schema: JsonSchemaNode | undefined) {
  if (!schema) {
    return;
  }
  schema.type = "array";
  schema.items = { type: "string" };
}

function normalizeDiscordGuildSchema(schema: JsonSchemaNode | undefined) {
  forceStringArrayItems(getSchemaNode(schema, ["properties", "users"]));
  forceStringArrayItems(getSchemaNode(schema, ["properties", "roles"]));
  const channelsSchema = getSchemaNode(schema, ["properties", "channels", "additionalProperties"]);
  forceStringArrayItems(getSchemaNode(channelsSchema, ["properties", "users"]));
  forceStringArrayItems(getSchemaNode(channelsSchema, ["properties", "roles"]));
}

function normalizeDiscordAccountSchema(schema: JsonSchemaNode | undefined) {
  forceStringArrayItems(getSchemaNode(schema, ["properties", "allowFrom"]));
  forceStringArrayItems(getSchemaNode(schema, ["properties", "dm", "properties", "allowFrom"]));
  forceStringArrayItems(getSchemaNode(schema, ["properties", "dm", "properties", "groupChannels"]));
  forceStringArrayItems(
    getSchemaNode(schema, ["properties", "execApprovals", "properties", "approvers"]),
  );
  normalizeDiscordGuildSchema(
    getSchemaNode(schema, ["properties", "guilds", "additionalProperties"]),
  );
}

function normalizeDiscordChannelConfigSchema(schema: JsonSchemaNode) {
  normalizeDiscordAccountSchema(schema);
  normalizeDiscordAccountSchema(
    getSchemaNode(schema, ["properties", "accounts", "additionalProperties"]),
  );
  return schema;
}

const baseSchema = buildChannelConfigSchema(DiscordConfigSchema);

export const DiscordChannelConfigSchema = {
  ...baseSchema,
  schema: normalizeDiscordChannelConfigSchema(baseSchema.schema),
};
