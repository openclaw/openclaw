import type { App } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

function fixture(config: ResolvedSlackAccount["config"] = {}) {
  const members = vi.fn().mockResolvedValue({ members: ["UOWNER"], response_metadata: {} });
  const ctx = createInboundSlackTestContext({
    cfg: { channels: { slack: { enabled: true } } },
    defaultRequireMention: false,
    appClient: { conversations: { members } } as unknown as App["client"],
  });
  ctx.allowFrom = ["UOWNER"];
  ctx.resolveUserName = async () => ({ name: "Bot" });
  const message: SlackMessageEvent = {
    type: "message",
    channel: "C123",
    channel_type: "channel",
    bot_id: "B_OTHER",
    subtype: "bot_message",
    username: "deploy-bot",
    text: "Readiness probe failed",
    ts: "1.000",
  };
  const prepare = () =>
    prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(config),
      message,
      opts: { source: "message" },
    });
  return { ctx, members, message, prepare };
}

describe("Slack bot-message admission", () => {
  it("preserves attachment-only bot DM content without treating it as commands (#27616)", async () => {
    const test = fixture({ allowBots: "mentions" });
    test.ctx.allowFrom = ["*"];
    Object.assign(test.message, {
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "",
      attachments: [{ text: "Readiness probe failed" }],
    });
    const prepared = await test.prepare();
    expect(prepared?.ctxPayload.RawBody).toContain("Readiness probe failed");
    expect(prepared?.ctxPayload.CommandBody).toBe("");
    expect(prepared?.ctxPayload.BodyForCommands).toBe("");
    expect(prepared?.ctxPayload.BodyForAgent).toContain("Readiness probe failed");
  });

  it("drops bot room messages when no owner is present (#59284)", async () => {
    const test = fixture({ allowBots: true });
    test.members.mockResolvedValue({ members: ["UOTHER"], response_metadata: {} });
    expect(await test.prepare()).toBeNull();
    expect(test.members).toHaveBeenCalledWith({ token: "token", channel: "C123", limit: 999 });
  });

  it("allows bot room messages by default when an owner is present", async () => {
    const test = fixture();
    expect((await test.prepare())?.ctxPayload.RawBody).toBe("Readiness probe failed");
    expect(test.members).toHaveBeenCalledTimes(1);
  });

  it("honors a room allowBots false override before checking owner presence", async () => {
    const test = fixture({ allowBots: true });
    test.ctx.channelsConfig = { C123: { allowBots: false } };
    test.ctx.channelsConfigKeys = ["C123"];
    expect(await test.prepare()).toBeNull();
    expect(test.members).not.toHaveBeenCalled();
  });

  it("ignores its own bot id without a user id", async () => {
    const test = fixture();
    test.message.bot_id = "B1";
    expect(await test.prepare()).toBeNull();
    expect(test.members).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires an explicit bot mention for mentions mode: %s",
    async (mentioned) => {
      const test = fixture({ allowBots: "mentions" });
      test.ctx.channelsConfig = { C123: { users: ["B_OTHER"] } };
      test.ctx.channelsConfigKeys = ["C123"];
      test.message.text = mentioned ? "hey <@B1> status failed" : "status failed";
      const prepared = await test.prepare();
      if (mentioned) {
        expect(prepared?.ctxPayload.RawBody).toContain("status failed");
      } else {
        expect(prepared).toBeNull();
      }
      expect(test.members).not.toHaveBeenCalled();
    },
  );

  it("fails closed when owner presence lookup fails (#59284)", async () => {
    const test = fixture({ allowBots: true });
    test.members.mockRejectedValue(new Error("missing_scope"));
    expect(await test.prepare()).toBeNull();
  });
});
