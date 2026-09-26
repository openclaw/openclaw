import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { assert, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext as createInboundSlackCtx,
  createSlackTestAccount as createSlackAccount,
} from "./prepare.test-helpers.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent: vi.fn(),
}));

describe("Slack bot-message admission", () => {
  function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
    return {
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "hi",
      ts: "1.000",
      ...overrides,
    } as SlackMessageEvent;
  }

  function createBotRoomMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return createSlackMessage({
      channel: "C123",
      channel_type: "channel",
      user: undefined,
      bot_id: "B0AGV8EQYA3",
      subtype: "bot_message",
      username: "deploy-bot",
      text: "Readiness probe failed",
      ...overrides,
    });
  }

  function createOwnerScopedBotRoomCtx(params: { members: string[] }) {
    const members = vi.fn().mockResolvedValue({
      members: params.members,
      response_metadata: { next_cursor: "" },
    });
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      appClient: { conversations: { members } } as unknown as App["client"],
      defaultRequireMention: false,
    });
    slackCtx.allowFrom = ["UOWNER"];
    return { slackCtx, members };
  }

  async function prepareMessageWith(
    ctx: SlackMonitorContext,
    account: ResolvedSlackAccount,
    message: SlackMessageEvent,
  ) {
    return prepareSlackMessage({
      ctx,
      account,
      message,
      opts: { source: "message" },
    });
  }

  it("extracts attachment text for bot messages with empty text when allowBots is true (#27616)", async () => {
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      defaultRequireMention: false,
    });
    slackCtx.resolveUserName = async () => ({ name: "Bot" });

    const account = createSlackAccount({ allowBots: true });
    const message = createSlackMessage({
      text: "",
      bot_id: "B0AGV8EQYA3",
      subtype: "bot_message",
      attachments: [
        {
          text: "Readiness probe failed: Get https://status.example.test/readiness: context deadline exceeded",
        },
      ],
    });

    const prepared = await prepareMessageWith(slackCtx, account, message);

    assert(prepared);
    expect(prepared.ctxPayload.RawBody).toContain("Readiness probe failed");
    // Slack message attachments can carry the user-visible body even when the
    // top-level message text is empty.
    expect(prepared.ctxPayload.CommandBody).toBe("");
    expect(prepared.ctxPayload.BodyForCommands).toBe("");
    expect(prepared.ctxPayload.BodyForAgent).toContain("Readiness probe failed");
  });

  it("drops bot-authored room messages when allowBots is true but no owner is present (#59284)", async () => {
    const { slackCtx, members } = createOwnerScopedBotRoomCtx({ members: ["UOTHER"] });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: true }),
      createBotRoomMessage(),
    );

    expect(prepared).toBeNull();
    expect(members).toHaveBeenCalledWith({ token: "token", channel: "C123", limit: 999 });
  });

  it.each([undefined, true])(
    "allows bot-authored room messages when an explicit owner is present (allowBots: %s)",
    async (allowBots) => {
      const { slackCtx, members } = createOwnerScopedBotRoomCtx({ members: ["UOWNER"] });

      const prepared = await prepareMessageWith(
        slackCtx,
        createSlackAccount({ allowBots }),
        createBotRoomMessage(),
      );

      assert(prepared);
      expect(prepared.ctxPayload.RawBody).toContain("Readiness probe failed");
      expect(members).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["root", "account", "room"] as const)(
    "honors explicit allowBots false at the %s scope",
    async (scope) => {
      const { slackCtx, members } = createOwnerScopedBotRoomCtx({ members: ["UOWNER"] });
      slackCtx.cfg.channels!.slack!.allowBots = scope !== "root";
      if (scope === "room") {
        slackCtx.channelsConfig = { C123: { allowBots: false } };
        slackCtx.channelsConfigKeys = ["C123"];
      }

      const prepared = await prepareMessageWith(
        slackCtx,
        createSlackAccount({ allowBots: scope === "account" ? false : undefined }),
        createBotRoomMessage(),
      );

      expect(prepared).toBeNull();
      expect(members).not.toHaveBeenCalled();
    },
  );

  it.each([
    { user: "B1", bot_id: "B0AGV8EQYA3" },
    { user: undefined, bot_id: "B1" },
  ])("ignores own bot messages identified by $user / $bot_id", async (identity) => {
    const { slackCtx, members } = createOwnerScopedBotRoomCtx({ members: ["UOWNER"] });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: true }),
      createBotRoomMessage(identity),
    );

    expect(prepared).toBeNull();
    expect(members).not.toHaveBeenCalled();
  });

  it("forwards bot sender status to ctxPayload when allowBots admits the bot", async () => {
    const { slackCtx } = createOwnerScopedBotRoomCtx({ members: ["UOWNER"] });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: true }),
      createBotRoomMessage(),
    );

    assert(prepared);
    expect(prepared.ctxPayload.SenderIsBot).toBe(true);
  });

  it("omits SenderIsBot for human messages", async () => {
    const slackCtx = createInboundSlackCtx({ cfg: { channels: { slack: { enabled: true } } } });
    slackCtx.resolveUserName = async () => ({ name: "Alice" });
    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount(),
      createSlackMessage({ text: "hello" }),
    );

    assert(prepared);
    expect(prepared.ctxPayload.SenderIsBot).toBeUndefined();
  });

  it("allows bot-authored room messages when the bot is explicitly channel-allowlisted (#59284)", async () => {
    const members = vi.fn();
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      appClient: { conversations: { members } } as unknown as App["client"],
      defaultRequireMention: false,
      channelsConfig: {
        C123: { users: ["B0AGV8EQYA3"] },
      },
    });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: true }),
      createBotRoomMessage(),
    );

    assert(prepared);
    expect(prepared.ctxPayload.RawBody).toContain("Readiness probe failed");
    expect(members).not.toHaveBeenCalled();
  });

  it("drops bot-authored room messages without mention when allowBots is mentions", async () => {
    const members = vi.fn();
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      appClient: { conversations: { members } } as unknown as App["client"],
      defaultRequireMention: false,
      channelsConfig: {
        C123: { users: ["B0AGV8EQYA3"] },
      },
    });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: "mentions" }),
      createBotRoomMessage({ text: "status failed" }),
    );

    expect(prepared).toBeNull();
    expect(members).not.toHaveBeenCalled();
  });

  it("allows bot-authored room messages with explicit mention when allowBots is mentions", async () => {
    const members = vi.fn();
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      appClient: { conversations: { members } } as unknown as App["client"],
      defaultRequireMention: false,
      channelsConfig: {
        C123: { users: ["B0AGV8EQYA3"] },
      },
    });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: "mentions" }),
      createBotRoomMessage({ text: "hey <@B1> status failed" }),
    );

    assert(prepared);
    expect(prepared.ctxPayload.RawBody).toContain("status failed");
    expect(members).not.toHaveBeenCalled();
  });

  it("allows bot-authored DM messages when allowBots is mentions", async () => {
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      defaultRequireMention: false,
    });
    slackCtx.resolveUserName = async () => ({ name: "Bot" });

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: "mentions" }),
      createSlackMessage({
        channel: "D123",
        channel_type: "im",
        text: "bot DM",
        bot_id: "B0AGV8EQYA3",
        subtype: "bot_message",
      }),
    );

    assert(prepared);
    expect(prepared.ctxPayload.RawBody).toContain("bot DM");
  });

  it("drops bot-authored room messages when owner presence lookup fails (#59284)", async () => {
    const members = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const slackCtx = createInboundSlackCtx({
      cfg: {
        channels: {
          slack: { enabled: true },
        },
      } as OpenClawConfig,
      appClient: { conversations: { members } } as unknown as App["client"],
      defaultRequireMention: false,
    });
    slackCtx.allowFrom = ["UOWNER"];

    const prepared = await prepareMessageWith(
      slackCtx,
      createSlackAccount({ allowBots: true }),
      createBotRoomMessage(),
    );

    expect(prepared).toBeNull();
  });
});
