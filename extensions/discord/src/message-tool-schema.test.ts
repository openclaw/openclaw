import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createDiscordMessageToolComponentsSchema } from "./message-tool-schema.js";

describe("createDiscordMessageToolComponentsSchema", () => {
  it("accepts plain text-only component payloads", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(Value.Check(schema, { text: "hello" })).toBe(true);
  });

  it("accepts action rows with buttons without requiring buttons on other block types", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(
      Value.Check(schema, {
        blocks: [
          { type: "text", text: "hello" },
          { type: "actions", buttons: [{ label: "Approve", style: "success" }] },
        ],
      }),
    ).toBe(true);
  });

  it("accepts select-only action rows", () => {
    const schema = createDiscordMessageToolComponentsSchema();
    expect(
      Value.Check(schema, {
        blocks: [
          {
            type: "actions",
            select: {
              type: "string",
              options: [{ label: "One", value: "1" }],
            },
          },
        ],
      }),
    ).toBe(true);
  });
});
