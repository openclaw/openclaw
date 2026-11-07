import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { normalizeTelegramBotInfo } from "./bot-info.js";
import { TelegramConfigSchema } from "./config-schema.js";
import { guestReplyText, registerTelegramGuestHandler } from "./guest.js";
import { getTelegramSequentialKey } from "./sequential-key.js";

const mocks = vi.hoisted(() => ({
  cfg: {} as OpenClawConfig,
  dispatch: vi.fn(),
  outcome: vi.fn(),
  lifecycle: undefined as
    | undefined
    | {
        abortSignal: AbortSignal;
        onAdopted: () => Promise<void>;
        onDeferred: () => void;
        onAbandoned: () => Promise<void>;
      },
}));
vi.mock("./runtime.js", () => ({
  getTelegramRuntime: () => ({ config: { current: () => mocks.cfg } }),
}));
vi.mock("./bot-processing-outcome.js", () => ({
  getTelegramSpooledReplayLifecycle: () => mocks.lifecycle,
  recordTelegramMessageProcessingResult: mocks.outcome,
}));
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>()),
  dispatchReplyWithBufferedBlockDispatcher: mocks.dispatch,
}));
const botInfo: UserFromGetMe = {
  id: 900,
  is_bot: true,
  first_name: "Guest",
  username: "guest_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  supports_guest_queries: true,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
function update(id = 1, caller = 42, chat = -100): Update {
  return {
    update_id: id,
    guest_message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: "group", title: "Synthetic" },
      from: { id: caller, is_bot: false, first_name: "Synthetic" },
      text: "Explain rainbows",
      guest_query_id: "synthetic-query",
    },
  };
}
function setup(accountId = "alpha", supportsGuest = true) {
  const api = vi.fn(async (_method: string, _payload: unknown) => ({
    inline_message_id: "synthetic-result",
  }));
  const bot = new Bot("123:synthetic", {
    botInfo: { ...botInfo, supports_guest_queries: supportsGuest },
  });
  const unexpectedApi = vi.fn();
  bot.api.config.use(async (_prev, method) => {
    unexpectedApi(method);
    throw new Error("Unexpected Telegram API in guest test");
  });
  vi.spyOn(bot.api, "answerGuestQuery").mockImplementation(async (query, result) =>
    api("answerGuestQuery", { guest_query_id: query, result }),
  );
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const handler = registerTelegramGuestHandler({ bot, accountId, runtime });
  return { bot, api, runtime, unexpectedApi, ...handler };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lifecycle = undefined;
  mocks.cfg = {
    agents: { entries: { default: {}, "alpha-agent": {}, "beta-agent": {} } },
    bindings: [
      { agentId: "alpha-agent", match: { channel: "telegram", accountId: "alpha" } },
      { agentId: "beta-agent", match: { channel: "telegram", accountId: "beta" } },
    ],
    channels: {
      telegram: {
        accounts: {
          alpha: { guestMode: { enabled: true, allowFrom: [42, 43] } },
          beta: { guestMode: { enabled: true, allowFrom: [42] } },
        },
      },
    },
  };
  mocks.dispatch.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
    await replyOptions.turnAdoptionLifecycle?.onAdopted();
    await dispatcherOptions.deliver(
      { text: "A rainbow is refracted sunlight." },
      { kind: "final" },
    );
  });
});
describe("Telegram guest ingress and delivery", () => {
  it("treats a guest request from a two-person private chat as public context", async () => {
    const event = update();
    event.guest_message!.chat = { id: 100, type: "private", first_name: "Synthetic" };
    const { bot, api } = setup();
    await bot.handleUpdate(event);
    expect(api).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]![0].ctx).toMatchObject({ ChatType: "group" });
  });
  it("dispatches a real grammY guest update and answers only its guest query", async () => {
    const { bot, api, unexpectedApi } = setup();
    await bot.handleUpdate(update());
    expect(unexpectedApi).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledExactlyOnceWith("answerGuestQuery", {
      guest_query_id: "synthetic-query",
      result: {
        type: "article",
        id: "guest-answer",
        title: "Answer",
        input_message_content: { message_text: "A rainbow is refracted sunlight." },
      },
    });
    const turn = mocks.dispatch.mock.calls[0]![0];
    expect(turn.ctx.SessionKey).toContain("agent:alpha-agent:");
    expect(turn.ctx.SessionKey).toContain("guest:-100:42:1");
    expect(turn.replyOptions).toMatchObject({
      disableTools: true,
      bootstrapContextMode: "lightweight",
      disableBlockStreaming: true,
    });
    expect(JSON.stringify(turn)).not.toContain("synthetic-query");
  });
  it.each(["disabled", "unauthorized", "unknown", "bot", "sender-chat", "unsupported", "expired"])(
    "rejects %s before any agent turn",
    async (reason) => {
      const event = update();
      const msg = event.guest_message!;
      if (reason === "disabled") {
        mocks.cfg.channels!.telegram!.accounts!.alpha!.guestMode = undefined;
      }
      if (reason === "unauthorized") {
        msg.from!.id = 99;
      }
      if (reason === "unknown") {
        Reflect.deleteProperty(msg, "from");
      }
      if (reason === "bot") {
        msg.from!.is_bot = true;
      }
      if (reason === "sender-chat") {
        msg.sender_chat = msg.chat;
      }
      if (reason === "expired") {
        msg.date -= 301;
      }
      const { bot, api } = setup("alpha", reason !== "unsupported");
      await bot.handleUpdate(event);
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(api).not.toHaveBeenCalled();
    },
  );
  it("isolates accounts, callers, chats, and successive interactions", async () => {
    const alpha = setup();
    const beta = setup("beta");
    for (const event of [update(), update(2), update(3, 43), update(4, 42, -200)]) {
      await alpha.bot.handleUpdate(event);
    }
    await beta.bot.handleUpdate(update());
    const keys = mocks.dispatch.mock.calls.map(([turn]) => turn.ctx.SessionKey);
    expect(new Set(keys).size).toBe(5);
    expect(keys[4]).toContain("agent:beta-agent:");
    expect(getTelegramSequentialKey({ update: update() })).toBe("telegram:guest:-100:42");
    expect(getTelegramSequentialKey({ update: { message: update().guest_message } })).not.toBe(
      "telegram:guest:-100:42",
    );
  });
  it.each(["stop", "revoke", "rebind"])(
    "does not publish after %s during generation",
    async (reason) => {
      const handler = setup();
      mocks.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
        if (reason === "stop") {
          handler.stop();
        }
        if (reason === "revoke") {
          mocks.cfg.channels!.telegram!.accounts!.alpha!.guestMode!.allowFrom = [];
        }
        if (reason === "rebind") {
          mocks.cfg.bindings![0]!.agentId = "beta-agent";
        }
        await dispatcherOptions.deliver({ text: "Must not be published" }, { kind: "final" });
      });
      await handler.bot.handleUpdate(update());
      expect(handler.api).not.toHaveBeenCalled();
    },
  );
  it("does not retry or leak an expired or ambiguous API error", async () => {
    const { bot, api, runtime } = setup();
    api.mockRejectedValue(new Error("synthetic-query private payload"));
    mocks.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      expect(await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" })).toMatchObject({
        ambiguous: true,
      });
      await dispatcherOptions.deliver({ text: "Retry must be suppressed" }, { kind: "final" });
    });
    await bot.handleUpdate(update());
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runtime.error.mock.calls)).not.toMatch(/synthetic-query|private payload/);
    expect(mocks.outcome).toHaveBeenLastCalledWith({ kind: "skipped" });
  });
  it("passes durable adoption to the existing ingress owner before the API effect", async () => {
    const adopted = vi.fn(async () => {});
    mocks.lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: adopted,
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };
    const { bot, api } = setup();
    await bot.handleUpdate(update());
    expect(adopted.mock.invocationCallOrder[0]).toBeLessThan(api.mock.invocationCallOrder[0]!);
  });
  it("ignores media and progress, emits one bounded final text", async () => {
    mocks.dispatch.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "private progress" }, { kind: "tool" });
      await dispatcherOptions.deliver(
        { mediaUrl: "https://example.invalid/private" },
        { kind: "final" },
      );
    });
    const { bot, api } = setup();
    await bot.handleUpdate(update());
    expect(JSON.stringify(api.mock.calls)).toContain(
      "This guest request produced no text response.",
    );
    expect(JSON.stringify(api.mock.calls)).not.toContain("private");
    expect(guestReplyText("x".repeat(4095) + "😀")).toHaveLength(4096);
    expect(guestReplyText("x".repeat(4094) + "😀x")).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
  it("keeps opt-in explicit, rejects wildcard callers, and requests guest updates for both transports", () => {
    expect(TelegramConfigSchema.parse({}).guestMode).toBeUndefined();
    expect(
      TelegramConfigSchema.safeParse({ guestMode: { enabled: true, allowFrom: ["*"] } }).success,
    ).toBe(false);
    expect(resolveTelegramAllowedUpdates()).toContain("guest_message");
    expect(normalizeTelegramBotInfo(botInfo)?.supports_guest_queries).toBe(true);
  });
});
