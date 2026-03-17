import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchMock,
  readAllowFromStoreMock,
  sendMock,
  updateLastRouteMock,
  upsertPairingRequestMock
} from "./monitor.tool-result.test-harness.js";
import { createDiscordMessageHandler } from "./monitor/message-handler.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { createNoopThreadBindingManager } from "./monitor/thread-bindings.js";
beforeEach(() => {
  __resetDiscordChannelInfoCacheForTest();
  sendMock.mockClear().mockResolvedValue(void 0);
  updateLastRouteMock.mockClear();
  dispatchMock.mockClear().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
});
const BASE_CFG = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      workspace: "/tmp/openclaw"
    }
  },
  session: { store: "/tmp/openclaw-sessions.json" }
};
const CATEGORY_GUILD_CFG = {
  ...BASE_CFG,
  channels: {
    discord: {
      dm: { enabled: true, policy: "open" },
      guilds: {
        "*": {
          requireMention: false,
          channels: { c1: { allow: true } }
        }
      }
    }
  }
};
function createHandlerBaseConfig(cfg, runtimeError) {
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "token",
    runtime: {
      log: vi.fn(),
      error: runtimeError ?? vi.fn(),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      }
    },
    botUserId: "bot-id",
    guildHistories: /* @__PURE__ */ new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1e4,
    textLimit: 2e3,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default")
  };
}
async function createDmHandler(opts) {
  return createDiscordMessageHandler(createHandlerBaseConfig(opts.cfg, opts.runtimeError));
}
function createDmClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      type: ChannelType.DM,
      name: "dm"
    })
  };
}
async function createCategoryGuildHandler() {
  return createDiscordMessageHandler({
    ...createHandlerBaseConfig(CATEGORY_GUILD_CFG),
    guildEntries: {
      "*": { requireMention: false, channels: { c1: { allow: true } } }
    }
  });
}
function createCategoryGuildClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      type: ChannelType.GuildText,
      name: "general",
      parentId: "category-1"
    }),
    rest: { get: vi.fn() }
  };
}
function createCategoryGuildEvent(params) {
  return {
    message: {
      id: params.messageId,
      content: "hello",
      channelId: "c1",
      timestamp: params.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: params.author
    },
    author: params.author,
    member: { displayName: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1"
  };
}
describe("discord tool result dispatch", () => {
  it("uses channel id allowlists for non-thread channels with categories", async () => {
    let capturedCtx;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { final: 1 } };
    });
    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();
    await handler(
      createCategoryGuildEvent({
        messageId: "m-category",
        author: { id: "u1", bot: false, username: "Ada", tag: "Ada#1" }
      }),
      client
    );
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:c1");
  });
  it("prefixes group bodies with sender label", async () => {
    let capturedBody = "";
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 } };
    });
    const handler = await createCategoryGuildHandler();
    const client = createCategoryGuildClient();
    await handler(
      createCategoryGuildEvent({
        messageId: "m-prefix",
        timestamp: (/* @__PURE__ */ new Date("2026-01-17T00:00:00Z")).toISOString(),
        author: { id: "u1", bot: false, username: "Ada", discriminator: "1234" }
      }),
      client
    );
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(capturedBody).toContain("Ada (Ada#1234): hello");
  });
  it("replies with pairing code and sender id when dmPolicy is pairing", async () => {
    const cfg = {
      ...BASE_CFG,
      channels: {
        discord: { dm: { enabled: true, policy: "pairing", allowFrom: [] } }
      }
    };
    const handler = await createDmHandler({ cfg });
    const client = createDmClient();
    await handler(
      {
        message: {
          id: "m1",
          content: "hello",
          channelId: "c1",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u2", bot: false, username: "Ada" }
        },
        author: { id: "u2", bot: false, username: "Ada" },
        guild_id: null
      },
      client
    );
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Your Discord user id: u2");
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  }, 1e4);
});
