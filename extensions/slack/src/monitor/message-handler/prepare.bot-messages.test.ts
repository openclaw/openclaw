import type { App } from "@slack/bolt";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

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

  it.each(["absent", "lookup failure"] as const)(
    "requires owner presence when no room users are configured: %s (#59284)",
    async (owner) => {
      const test = fixture({ allowBots: true });
      if (owner === "lookup failure") {
        test.members.mockRejectedValue(new Error("missing_scope"));
      } else {
        test.members.mockResolvedValue({
          members: ["UOTHER"],
          response_metadata: {},
        });
      }
      const prepared = await test.prepare();
      expect(prepared).toBeNull();
      expect(test.members).toHaveBeenCalledExactlyOnceWith({
        token: "token",
        channel: "C123",
        limit: 999,
      });
    },
  );

  it.each(["room override", "self", "unmentioned"] as const)(
    "applies bot admission before owner lookup: %s",
    async (mode) => {
      const test = fixture({
        allowBots: mode === "room override" ? true : mode === "self" ? undefined : "mentions",
      });
      if (mode !== "self") {
        test.ctx.channelsConfig = {
          C123: mode === "room override" ? { allowBots: false } : { users: ["B_OTHER"] },
        };
        test.ctx.channelsConfigKeys = ["C123"];
      }
      test.message.bot_id = mode === "self" ? "B1" : "B_OTHER";
      test.message.text = "status failed";
      const prepared = await test.prepare();
      expect(prepared).toBeNull();
      expect(test.members).not.toHaveBeenCalled();
    },
  );
});

const store = createSlackSessionStoreFixture("slack-rejection-record-");
afterEach(() => vi.restoreAllMocks());
function rejectionFixture() {
  const ctx = createInboundSlackTestContext({
    cfg: {
      session: { store: store.makeTmpStorePath().storePath },
      channels: { slack: { enabled: true } },
    },
  });
  ctx.resolveUserName = async () => ({ name: "Synthetic sender" });
  ctx.resolveChannelName = async () => ({ name: "synthetic-room", type: "channel" });
  const info = vi.spyOn(ctx.logger, "info").mockImplementation(() => undefined);
  const message: SlackMessageEvent = {
    type: "message",
    channel: "D123",
    channel_type: "im",
    user: "U1",
    ts: "1.000",
    text: "private message content must not enter rejection records",
  };
  const prepare = () =>
    prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(),
      message,
      opts: { source: "message" },
    });
  const expectRejection = (reason: string) =>
    expect(info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "slack",
        accountId: "default",
        teamId: "T1",
        channelId: "D123",
        messageTs: "1.000",
        source: "message",
        reason,
      },
      "Slack inbound event rejected during preparation",
    );
  return { ctx, info, message, prepare, expectRejection };
}

describe("Slack preparation rejection records", () => {
  it.each(["missing-user", "dm-disabled", "dm-unauthorized", "channel-not-allowed"] as const)(
    "records only routing facts for %s",
    async (reason) => {
      const test = rejectionFixture();
      if (reason === "missing-user") {
        test.message.user = undefined;
      }
      if (reason === "dm-disabled") {
        test.ctx.dmPolicy = "disabled";
      }
      if (reason === "channel-not-allowed") {
        test.ctx.dmEnabled = false;
      }
      if (reason === "dm-unauthorized") {
        test.ctx.dmPolicy = "allowlist";
        test.ctx.allowFrom = ["U_ALLOWED"];
      }
      expect(await test.prepare()).toBeNull();
      test.expectRejection(reason);
    },
  );
});
