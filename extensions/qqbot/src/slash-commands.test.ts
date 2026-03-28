import { describe, expect, it } from "vitest";
import { matchSlashCommand, type SlashCommandContext } from "./slash-commands.js";

/** Build a minimal SlashCommandContext for testing. */
function buildCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    type: "c2c",
    senderId: "test-user-001",
    messageId: "msg-001",
    eventTimestamp: new Date().toISOString(),
    receivedAt: Date.now(),
    rawContent: "/bot-ping",
    args: "",
    accountId: "default",
    appId: "000000",
    commandAuthorized: true,
    queueSnapshot: {
      totalPending: 0,
      activeUsers: 0,
      maxConcurrentUsers: 10,
      senderPending: 0,
    },
    ...overrides,
  };
}

describe("slash command authorization", () => {
  // ---- /bot-logs (requireAuth: true) ----

  it("rejects /bot-logs for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-logs",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
    expect(result as string).toContain("/bot-logs");
  });

  it("allows /bot-logs for authorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-logs",
      commandAuthorized: true,
    });
    const result = await matchSlashCommand(ctx);
    // Authorized call should not return the rejection message.
    // It may return a string (no logs found) or a file result — either way, not a rejection.
    if (typeof result === "string") {
      expect(result).not.toContain("权限不足");
    } else {
      // SlashCommandFileResult with text + filePath
      expect(result).toHaveProperty("text");
      expect(result).toHaveProperty("filePath");
    }
  });

  // ---- /bot-ping (no requireAuth) ----

  it("allows /bot-ping for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-ping",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  it("allows /bot-ping for authorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-ping",
      commandAuthorized: true,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("pong");
  });

  // ---- /bot-help (no requireAuth) ----

  it("allows /bot-help for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-help",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("QQBot");
  });

  // ---- /bot-version (no requireAuth) ----

  it("allows /bot-version for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-version",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("OpenClaw");
  });

  // ---- unknown commands ----

  it("returns null for unknown slash commands", async () => {
    const ctx = buildCtx({
      rawContent: "/unknown-command",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  it("returns null for non-slash messages", async () => {
    const ctx = buildCtx({
      rawContent: "hello",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeNull();
  });

  // ---- usage query (?) ----

  it("rejects /bot-logs ? for unauthorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-logs ?",
      commandAuthorized: false,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("权限不足");
  });

  it("shows /bot-logs usage for authorized sender", async () => {
    const ctx = buildCtx({
      rawContent: "/bot-logs ?",
      commandAuthorized: true,
    });
    const result = await matchSlashCommand(ctx);
    expect(result).toBeTypeOf("string");
    expect(result as string).toContain("用法");
  });
});
