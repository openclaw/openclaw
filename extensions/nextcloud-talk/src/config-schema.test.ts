import { describe, expect, it } from "vitest";
import { NextcloudTalkConfigSchema } from "./config-schema.js";

describe("NextcloudTalkConfigSchema SecretInput", () => {
  it("accepts SecretRef botSecret and apiPassword at top-level", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      baseUrl: "https://cloud.example.com",
      botSecret: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_BOT_SECRET" },
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "NEXTCLOUD_TALK_API_PASSWORD" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botSecret and apiPassword on account", () => {
    const result = NextcloudTalkConfigSchema.safeParse({
      accounts: {
        main: {
          baseUrl: "https://cloud.example.com",
          botSecret: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_BOT_SECRET",
          },
          apiUser: "bot",
          apiPassword: {
            source: "env",
            provider: "default",
            id: "NEXTCLOUD_TALK_MAIN_API_PASSWORD",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
