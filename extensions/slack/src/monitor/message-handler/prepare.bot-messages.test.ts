import type { App } from "@slack/bolt";
import { afterEach, expect, it, vi } from "vitest";
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

const store = createSlackSessionStoreFixture("slack-rejection-record-");
afterEach(() => vi.restoreAllMocks());
function fixture(config: ResolvedSlackAccount["config"] = {}, direct = false) {
  const members = vi.fn().mockResolvedValue({ members: ["UOWNER"], response_metadata: {} });
  const ctx = createInboundSlackTestContext({
    cfg: {
      ...(direct ? { session: { store: store.makeTmpStorePath().storePath } } : {}),
      channels: { slack: { enabled: true } },
    },
    defaultRequireMention: direct,
    appClient: direct ? undefined : ({ conversations: { members } } as unknown as App["client"]),
  });
  ctx.allowFrom = direct ? ["*"] : ["UOWNER"];
  ctx.resolveUserName = async () => ({ name: direct ? "Synthetic sender" : "Bot" });
  if (direct) {
    ctx.resolveChannelName = async () => ({ name: "synthetic-room", type: "channel" });
  }
  const info = direct
    ? vi.spyOn(ctx.logger, "info").mockImplementation(() => undefined)
    : undefined;
  const message: SlackMessageEvent = {
    type: "message",
    channel: direct ? "D123" : "C123",
    channel_type: direct ? "im" : "channel",
    ...(direct
      ? { user: "U1" }
      : { bot_id: "B_OTHER", subtype: "bot_message", username: "deploy-bot" }),
    text: direct
      ? "private message content must not enter rejection records"
      : "Readiness probe failed",
    ts: "1.000",
  };
  const account = createSlackTestAccount(config);
  const prepare = () => prepareSlackMessage({ ctx, account, message, opts: { source: "message" } });
  return { ctx, members, info, message, prepare };
}

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
  expect(prepared?.ctxPayload).toMatchObject({ CommandBody: "", BodyForCommands: "" });
  expect(prepared?.ctxPayload.BodyForAgent).toContain("Readiness probe failed");
});

it.each(["absent", "lookup failure"] as const)(
  "requires owner presence when no room users are configured: %s (#59284)",
  async (owner) => {
    const test = fixture({ allowBots: true });
    if (owner === "lookup failure") {
      test.members.mockRejectedValue(new Error("missing_scope"));
    } else {
      test.members.mockResolvedValue({ members: ["UOTHER"], response_metadata: {} });
    }
    expect(await test.prepare()).toBeNull();
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
    expect(await test.prepare()).toBeNull();
    expect(test.members).not.toHaveBeenCalled();
  },
);
it.each(["missing-user", "dm-disabled", "dm-unauthorized", "channel-not-allowed"] as const)(
  "records only routing facts for %s",
  async (reason) => {
    const test = fixture({}, true);
    test.message.user = reason === "missing-user" ? undefined : "U1";
    test.ctx.dmEnabled = reason !== "channel-not-allowed";
    test.ctx.dmPolicy =
      reason === "dm-disabled" ? "disabled" : reason === "dm-unauthorized" ? "allowlist" : "open";
    test.ctx.allowFrom = reason === "dm-unauthorized" ? ["U_ALLOWED"] : ["*"];
    expect(await test.prepare()).toBeNull();
    expect(test.info).toHaveBeenCalledExactlyOnceWith(
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
  },
);
