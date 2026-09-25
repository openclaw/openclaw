import { describe, expect, it } from "vitest";
import { ZalouserConfigSchema } from "./config-schema.js";
import type { ZalouserConfig } from "./types.js";

describe("ZalouserConfigSchema", () => {
  it("accepts schema-derived account and group config input", () => {
    const input = {
      defaultAccount: "personal",
      accounts: {
        personal: {
          markdown: { tables: "off" },
          groupPolicy: "allowlist",
          groups: {
            family: {
              requireMention: false,
              tools: { allow: ["message"] },
            },
          },
        },
      },
    } satisfies ZalouserConfig;

    expect(ZalouserConfigSchema.safeParse(input).success).toBe(true);
  });
});
