import { describe, expect, it } from "vitest";
import {
  classifyManagedBotError,
  createManagedBotWithToken,
  validateBotName,
  validateBotUsername,
} from "./mtproto-managed-bots.js";

describe("mtproto managed bots", () => {
  it("validates usernames (suffix + charset + length)", () => {
    expect(validateBotUsername("mybot_bot").valid).toBe(true);
    expect(validateBotUsername("@mybot_bot").valid).toBe(true);
    expect(validateBotUsername("ab_bot").valid).toBe(true);
    expect(validateBotUsername("mybot").valid).toBe(true);
    expect(validateBotUsername("myuser1").valid).toBe(false);
    expect(validateBotUsername("ab_bo").valid).toBe(false);
    expect(validateBotUsername("bad-name_bot").valid).toBe(false);
  });

  it("validates display names", () => {
    expect(validateBotName("My Bot").valid).toBe(true);
    expect(validateBotName("").valid).toBe(false);
    expect(validateBotName("x".repeat(65)).valid).toBe(false);
  });

  it("classifies known RPC errors (no updateBot/getBotToken/resetBotToken)", () => {
    expect(classifyManagedBotError("USERNAME_OCCUPIED")).toBe("USERNAME_OCCUPIED");
    expect(classifyManagedBotError("BOT_CREATE_LIMIT_EXCEEDED")).toBe("BOT_CREATE_LIMIT_EXCEEDED");
    expect(classifyManagedBotError("MANAGER_PERMISSION_MISSING")).toBe(
      "MANAGER_PERMISSION_MISSING",
    );
    expect(classifyManagedBotError("something else")).toBe("UNKNOWN");
  });

  it("runs check → create → export split-session flow", async () => {
    const calls: string[] = [];
    const result = await createManagedBotWithToken({
      creator: {
        async checkUsername(u) {
          calls.push(`check:${u}`);
          return true;
        },
        async createBot(p) {
          calls.push(`create:${p.username}`);
          return { botId: "123" };
        },
      },
      exporter: {
        async exportBotToken(p) {
          calls.push(`export:${p.botId}:${p.revoke}`);
          return { token: "123:ABC" };
        },
      },
      name: "My Bot",
      username: "@mybot_bot",
    });
    expect(result).toEqual({ botId: "123", token: "123:ABC" });
    expect(calls).toEqual(["check:mybot_bot", "create:mybot_bot", "export:123:false"]);
  });

  it("rejects occupied usernames before create", async () => {
    await expect(
      createManagedBotWithToken({
        creator: { checkUsername: async () => false, createBot: async () => ({ botId: "1" }) },
        exporter: { exportBotToken: async () => ({ token: "1:A" }) },
        name: "B",
        username: "taken_bot",
      }),
    ).rejects.toThrow("USERNAME_OCCUPIED");
  });
});
