import { describe, expect, it } from "vitest";
import { MattermostConfigSchema } from "./config-schema.js";

describe("MattermostConfigSchema SecretInput", () => {
  it("accepts SecretRef botToken at top-level", () => {
    const result = MattermostConfigSchema.safeParse({
      botToken: { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN" },
      baseUrl: "https://chat.example.com",
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botToken on account", () => {
    const result = MattermostConfigSchema.safeParse({
      accounts: {
        main: {
          botToken: { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN_MAIN" },
          baseUrl: "https://chat.example.com",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
