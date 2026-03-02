import { describe, expect, it } from "vitest";
import {
  TELEGRAM_USERBOT_CHANNEL_ID,
  telegramUserbotConfigSchema,
  telegramUserbotMeta,
} from "./config-schema.js";

describe("telegramUserbotConfigSchema", () => {
  it("accepts a valid minimal config (apiId + apiHash only)", () => {
    const parsed = telegramUserbotConfigSchema.safeParse({
      apiId: 14858133,
      apiHash: "abc123def456",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects config missing apiId", () => {
    const parsed = telegramUserbotConfigSchema.safeParse({
      apiHash: "abc123def456",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects config missing apiHash", () => {
    const parsed = telegramUserbotConfigSchema.safeParse({
      apiId: 14858133,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty config object", () => {
    const parsed = telegramUserbotConfigSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("parses a full config with all optional fields", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      allowFrom: [267619672, "@alice"],
      rateLimit: {
        messagesPerSecond: 10,
        perChatPerSecond: 2,
        jitterMs: [100, 300],
      },
      reconnect: {
        maxAttempts: 5,
        alertAfterFailures: 2,
      },
      capabilities: {
        deleteOtherMessages: false,
        readHistory: false,
        forceDocument: false,
      },
    });

    expect(parsed.apiId).toBe(14858133);
    expect(parsed.apiHash).toBe("abc123def456");
    expect(parsed.allowFrom).toEqual([267619672, "@alice"]);
    expect(parsed.rateLimit?.messagesPerSecond).toBe(10);
    expect(parsed.rateLimit?.perChatPerSecond).toBe(2);
    expect(parsed.rateLimit?.jitterMs).toEqual([100, 300]);
    expect(parsed.reconnect?.maxAttempts).toBe(5);
    expect(parsed.reconnect?.alertAfterFailures).toBe(2);
    expect(parsed.capabilities?.deleteOtherMessages).toBe(false);
    expect(parsed.capabilities?.readHistory).toBe(false);
    expect(parsed.capabilities?.forceDocument).toBe(false);
  });

  it("applies default values for rateLimit when the object is provided without fields", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      rateLimit: {},
    });

    expect(parsed.rateLimit?.messagesPerSecond).toBe(20);
    expect(parsed.rateLimit?.perChatPerSecond).toBe(1);
    expect(parsed.rateLimit?.jitterMs).toEqual([50, 200]);
  });

  it("applies default values for reconnect when the object is provided without fields", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      reconnect: {},
    });

    expect(parsed.reconnect?.maxAttempts).toBe(-1);
    expect(parsed.reconnect?.alertAfterFailures).toBe(3);
  });

  it("applies default values for capabilities when the object is provided without fields", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      capabilities: {},
    });

    expect(parsed.capabilities?.deleteOtherMessages).toBe(true);
    expect(parsed.capabilities?.readHistory).toBe(true);
    expect(parsed.capabilities?.forceDocument).toBe(true);
  });

  it("accepts allowFrom with mixed numeric and string entries", () => {
    const parsed = telegramUserbotConfigSchema.parse({
      apiId: 14858133,
      apiHash: "abc123def456",
      allowFrom: [123, "456", "@bob", 789],
    });

    expect(parsed.allowFrom).toEqual([123, "456", "@bob", 789]);
  });
});

describe("telegramUserbotMeta", () => {
  it("has the correct channel id", () => {
    expect(telegramUserbotMeta.id).toBe("telegram-userbot");
  });

  it("matches the CHANNEL_ID constant", () => {
    expect(telegramUserbotMeta.id).toBe(TELEGRAM_USERBOT_CHANNEL_ID);
  });

  it("has a label and blurb", () => {
    expect(telegramUserbotMeta.label).toBe("Telegram (User)");
    expect(telegramUserbotMeta.blurb).toBeTruthy();
  });
});
