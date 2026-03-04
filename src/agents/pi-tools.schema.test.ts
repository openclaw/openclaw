import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";

describe("normalizeToolParameters", () => {
  it("drops oversized maxLength constraints that can break llama.cpp grammars", () => {
    const tool = {
      name: "sessions_spawn",
      description: "test",
      parameters: {
        type: "object",
        properties: {
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string", maxLength: 6_700_000 },
                name: { type: "string", maxLength: 255 },
              },
            },
          },
        },
      },
      execute: async () => ({ ok: true }),
    } as const;

    const normalized = normalizeToolParameters(tool as never) as {
      parameters: {
        properties: {
          attachments: {
            items: {
              properties: {
                content: { maxLength?: number };
                name: { maxLength?: number };
              };
            };
          };
        };
      };
    };

    expect(
      normalized.parameters.properties.attachments.items.properties.content.maxLength,
    ).toBeUndefined();
    expect(normalized.parameters.properties.attachments.items.properties.name.maxLength).toBe(255);
  });
});
