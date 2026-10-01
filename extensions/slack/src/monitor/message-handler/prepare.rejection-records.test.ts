import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

const store = createSlackSessionStoreFixture("slack-rejection-record-");
beforeAll(() => store.setup());
afterAll(() => store.cleanup());
afterEach(() => vi.restoreAllMocks());
function fixture() {
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
  const prepare = (source: "message" | "app_mention" = "message") =>
    prepareSlackMessage({ ctx, account: createSlackTestAccount(), message, opts: { source } });
  const expectRejection = (reason: string, channelId = "D123") =>
    expect(info).toHaveBeenCalledExactlyOnceWith(
      {
        provider: "slack",
        accountId: "default",
        teamId: "T1",
        channelId,
        messageTs: "1.000",
        source: "message",
        reason,
      },
      "Slack inbound event rejected during preparation",
    );
  return { ctx, info, message, prepare, expectRejection };
}

describe("Slack preparation rejection records", () => {
  it.each([
    "missing-user",
    "dm-disabled",
    "dm-unauthorized",
    "bot-disabled",
    "channel-not-allowed",
  ] as const)("records only routing facts for %s", async (reason) => {
    const test = fixture();
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
    if (reason === "bot-disabled") {
      test.ctx.cfg.channels!.slack!.allowBots = false;
      test.message.bot_id = "B_OTHER";
      test.message.subtype = "bot_message";
    }
    expect(await test.prepare()).toBeNull();
    test.expectRejection(reason);
  });

  it("does not report self-message loop prevention as a rejected user attempt", async () => {
    const { message, info, prepare } = fixture();
    message.user = "B1";
    message.bot_id = "B1";
    message.subtype = "bot_message";
    expect(await prepare()).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it("records an unmentioned attempt while its app_mention twin still prepares", async () => {
    const test = fixture();
    test.message.channel = "C123";
    test.message.channel_type = "channel";
    test.ctx.historyLimit = 5;
    expect(await test.prepare()).toBeNull();
    test.expectRejection("missing-mention", "C123");
    expect((await test.prepare("app_mention"))?.ctxPayload.MentionSource).toBe("explicit_bot");
    expect(test.info).toHaveBeenCalledTimes(1);
  });
});
