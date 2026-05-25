import { describe, expect, it } from "vitest";
import { LineConfigSchema } from "./config-schema.js";

describe("LineConfigSchema", () => {
  it('rejects dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
    });

    if (result.success) {
      throw new Error("Expected config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });

  it('accepts dmPolicy="open" with wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: "token",
      channelSecret: "secret",
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef credentials at top-level", () => {
    const result = LineConfigSchema.safeParse({
      channelAccessToken: { source: "env", provider: "default", id: "LINE_CHANNEL_ACCESS_TOKEN" },
      channelSecret: { source: "env", provider: "default", id: "LINE_CHANNEL_SECRET" },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef credentials on account", () => {
    const result = LineConfigSchema.safeParse({
      accounts: {
        work: {
          channelAccessToken: {
            source: "env",
            provider: "default",
            id: "LINE_WORK_CHANNEL_ACCESS_TOKEN",
          },
          channelSecret: { source: "env", provider: "default", id: "LINE_WORK_CHANNEL_SECRET" },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects account dmPolicy="open" without wildcard allowFrom', () => {
    const result = LineConfigSchema.safeParse({
      accounts: {
        work: {
          channelAccessToken: "token",
          channelSecret: "secret",
          dmPolicy: "open",
        },
      },
    });

    if (result.success) {
      throw new Error("Expected account config validation to fail");
    }
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["accounts", "work", "allowFrom"]);
    expect(result.error.issues[0]?.message).toBe(
      'channels.line.dmPolicy="open" requires channels.line.allowFrom to include "*"',
    );
  });
});
