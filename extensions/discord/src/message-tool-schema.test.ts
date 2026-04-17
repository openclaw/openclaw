import { describe, expect, it } from "vitest";
import { createDiscordMessageToolComponentsSchema } from "./message-tool-schema.js";

describe("createDiscordMessageToolComponentsSchema", () => {
  it("accepts plain text-only component payloads", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(schema).toMatchObject({
      properties: {
        text: { type: "string" },
      },
    });
  });

  it("constrains block types to the supported Discord component values", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(schema.properties.blocks).toMatchObject({
      type: "array",
      items: {
        properties: {
          type: {
            type: "string",
            enum: ["text", "section", "separator", "actions", "media-gallery", "file"],
          },
          buttons: { type: "array" },
          select: { type: "object" },
        },
      },
    });
  });

  it("keeps block-specific fields optional so non-action blocks do not require buttons", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(schema.properties.blocks.items.required ?? []).not.toContain("buttons");
    expect(schema.properties.blocks.items.required ?? []).not.toContain("select");
  });
});
