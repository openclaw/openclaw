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
  // ---- /bot-logs (moved to framework registerCommand) ----
  // /bot-logs is registered with the framework via registerCommand() so that
  // resolveCommandAuthorization() enforces commands.allowFrom.qqbot precedence
  // and qqbot: prefix normalization. It is no longer in the pre-dispatch
  // slash-command registry, so matchSlashCommand returns null and lets the
  // normal inbound queue handle it.

  it("passes /bot-logs through to the framework (returns null)", async () => {
    const ctx = buildCtx({ rawContent: "/bot-logs", commandAuthorized: false });
    expect(await matchSlashCommand(ctx)).toBeNull();
  });

  it("passes /bot-logs ? through to the framework (returns null)", async () => {
    const ctx = buildCtx({ rawContent: "/bot-logs ?", commandAuthorized: false });
    expect(await matchSlashCommand(ctx)).toBeNull();
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

  // ---- usage query (?) for remaining pre-dispatch commands ----
});
