import { describe, expect, it } from "vitest";
import { DiscordChannelConfigSchema } from "./config-schema.js";

type JsonSchemaNode = Record<string, unknown>;

function getSchemaNode(path: readonly string[]) {
  let current: unknown = DiscordChannelConfigSchema.schema;
  for (const key of path) {
    current = current && typeof current === "object" ? (current as JsonSchemaNode)[key] : undefined;
  }
  return current as JsonSchemaNode | undefined;
}

describe("DiscordChannelConfigSchema", () => {
  it("publishes Discord snowflake ID lists as string arrays", () => {
    const idListPaths = [
      ["properties", "allowFrom"],
      ["properties", "dm", "properties", "allowFrom"],
      ["properties", "dm", "properties", "groupChannels"],
      ["properties", "execApprovals", "properties", "approvers"],
      ["properties", "guilds", "additionalProperties", "properties", "users"],
      ["properties", "guilds", "additionalProperties", "properties", "roles"],
      [
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "channels",
        "additionalProperties",
        "properties",
        "users",
      ],
      [
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "channels",
        "additionalProperties",
        "properties",
        "roles",
      ],
      ["properties", "accounts", "additionalProperties", "properties", "allowFrom"],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "dm",
        "properties",
        "allowFrom",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "dm",
        "properties",
        "groupChannels",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "execApprovals",
        "properties",
        "approvers",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "users",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "roles",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "channels",
        "additionalProperties",
        "properties",
        "users",
      ],
      [
        "properties",
        "accounts",
        "additionalProperties",
        "properties",
        "guilds",
        "additionalProperties",
        "properties",
        "channels",
        "additionalProperties",
        "properties",
        "roles",
      ],
    ] as const;

    for (const path of idListPaths) {
      const node = getSchemaNode(path);
      expect(node).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
      expect(getSchemaNode([...path, "items", "anyOf"])).toBeUndefined();
    }
  });
});
