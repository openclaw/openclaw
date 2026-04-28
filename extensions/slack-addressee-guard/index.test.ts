import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register, { __testing } from "./index.js";

const TARGET = "U0518D47N3X"; // Miles
const BOT = "U0AKLRW2NHH"; // Prest0n
const HUMAN_A = "U06GNTHJNG5"; // Malaika

type RunHookFn = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<{ cancel?: boolean; content?: string } | undefined>;

function makeApi(config: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: { message_sending?: RunHookFn };
} {
  const hooks: { message_sending?: RunHookFn } = {};
  const api = {
    pluginConfig: config,
    id: "slack-addressee-guard",
    name: "Slack Addressee Guard",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: (hookName: string, handler: RunHookFn) => {
      hooks[hookName as "message_sending"] = handler;
    },
  } as unknown as OpenClawPluginApi;
  return { api, hooks };
}

describe("slack-addressee-guard — pure helpers", () => {
  it("parseChannelAndThread resolves metadata.channelId and threadTs", () => {
    const target = __testing.parseChannelAndThread(
      { metadata: { channelId: "C123", threadTs: "1.2" } },
      undefined,
    );
    expect(target).toEqual({ channelId: "C123", threadTs: "1.2" });
  });

  it("parseChannelAndThread falls back to conversationId + replyToId", () => {
    const target = __testing.parseChannelAndThread(
      { replyToId: "9.9", metadata: {} },
      "C456",
    );
    expect(target).toEqual({ channelId: "C456", threadTs: "9.9" });
  });

  it("parseChannelAndThread returns null for non-Slack channel ids", () => {
    const target = __testing.parseChannelAndThread(
      { metadata: { channelId: "not-a-slack-id", threadTs: "1.2" } },
      undefined,
    );
    expect(target).toBeNull();
  });

  it("repairContent rewrites only the leading target mention", () => {
    const rewritten = __testing.repairContent(
      `<@${TARGET}> please ack this (also <@${TARGET}> fyi)`,
      TARGET,
      HUMAN_A,
    );
    expect(rewritten).toBe(`<@${HUMAN_A}> please ack this (also <@${TARGET}> fyi)`);
  });

  it("repairContent prepends a mention when none leads the text", () => {
    const rewritten = __testing.repairContent(`hello folks`, TARGET, HUMAN_A);
    expect(rewritten).toBe(`<@${HUMAN_A}> hello folks`);
  });

  it("lastHumanBeforeBot skips the bot and bot_message subtype entries", () => {
    const msgs = [
      { user: HUMAN_A, text: "hi", ts: "1.0" },
      { user: BOT, text: "reply", ts: "1.1" },
      { user: "UOTHER", text: "", ts: "1.2", subtype: "bot_message", bot_id: "B1" },
    ];
    const last = __testing.lastHumanBeforeBot(msgs, BOT);
    expect(last?.user).toBe(HUMAN_A);
  });

  it("priorHumanAskedForTarget recognises direct target mentions and trigger phrases", () => {
    const phrases = [...__testing.DEFAULT_ASKED_FOR_TARGET_PHRASES];
    expect(
      __testing.priorHumanAskedForTarget("please ping Miles about this", TARGET, phrases),
    ).toBe(true);
    expect(
      __testing.priorHumanAskedForTarget(`loop <@${TARGET}> in`, TARGET, phrases),
    ).toBe(true);
    expect(
      __testing.priorHumanAskedForTarget("what happened next?", TARGET, phrases),
    ).toBe(false);
  });

  it("matchesAllowlist handles sign-off nudges and PM headers", () => {
    const patterns = __testing.DEFAULT_ALLOWLIST_PATTERNS.map((p) => new RegExp(p, "i"));
    expect(
      __testing.matchesAllowlist(
        `:alarm_clock: *AEO Project — sign-off nudge #25*`,
        patterns,
      ),
    ).toBe(true);
    expect(
      __testing.matchesAllowlist(`⚡ [PM-Pulse] status check`, patterns),
    ).toBe(true);
    expect(
      __testing.matchesAllowlist(`ordinary reply leading with <@${TARGET}>`, patterns),
    ).toBe(false);
  });

  it("buildResolvedConfig enforces required targetUserId/botUserId + disabled flag", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    try {
      expect(__testing.buildResolvedConfig({ enabled: false })).toBeNull();
      expect(__testing.buildResolvedConfig({})).toBeNull();
      expect(
        __testing.buildResolvedConfig({
          targetUserId: TARGET,
          botUserId: "bogus",
        }),
      ).toBeNull();
      const ok = __testing.buildResolvedConfig({
        targetUserId: TARGET,
        botUserId: BOT,
      });
      expect(ok).not.toBeNull();
      expect(ok?.mode).toBe("rewrite");
    } finally {
      delete process.env.SLACK_BOT_TOKEN;
    }
  });
});

describe("slack-addressee-guard — message_sending hook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __testing.clearCacheForTests();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_BOT_TOKEN;
    vi.restoreAllMocks();
  });

  async function callHook(
    config: Record<string, unknown>,
    event: Record<string, unknown>,
    ctx: Record<string, unknown> = { channelId: "slack", conversationId: "C123" },
  ): Promise<{ cancel?: boolean; content?: string } | undefined> {
    const { api, hooks } = makeApi(config);
    register.register(api);
    const handler = hooks.message_sending;
    if (!handler) {
      throw new Error("handler not registered");
    }
    return handler(event, ctx);
  }

  function mockFetchThreadMessages(messages: Array<Record<string, unknown>>): void {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages }),
    });
  }

  it("passes through for non-slack channels", async () => {
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      { content: `<@${TARGET}> hi`, to: "C123", metadata: { channelId: "C123", threadTs: "1.2" } },
      { channelId: "telegram", conversationId: "C123" },
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through when content does not mention the target user", async () => {
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      { content: `<@${HUMAN_A}> already addressed`, to: "C123", metadata: { channelId: "C123", threadTs: "1.2" } },
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through sign-off nudge cron headers without calling Slack", async () => {
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      {
        content: `:alarm_clock: *AEO Project — sign-off nudge #25* <@${TARGET}> please sign off`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.2" },
      },
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rewrites when another human spoke last and did not ask for the target", async () => {
    mockFetchThreadMessages([
      { user: TARGET, text: "kickoff", ts: "1.0" },
      { user: BOT, text: "working", ts: "1.1" },
      { user: HUMAN_A, text: "what's next?", ts: "1.2" },
    ]);
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      {
        content: `<@${TARGET}> looking into it`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.0" },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: `<@${HUMAN_A}> looking into it` });
  });

  it("cancels instead of rewriting when mode=cancel", async () => {
    mockFetchThreadMessages([
      { user: HUMAN_A, text: "what's next?", ts: "1.2" },
    ]);
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT, mode: "cancel" },
      {
        content: `<@${TARGET}> looking into it`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.0" },
      },
    );
    expect(result).toEqual({ cancel: true });
  });

  it("passes through when the last human explicitly asked to ping the target", async () => {
    mockFetchThreadMessages([
      { user: HUMAN_A, text: `please ping <@${TARGET}> about this`, ts: "1.2" },
    ]);
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      {
        content: `<@${TARGET}> noted`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.0" },
      },
    );
    expect(result).toBeUndefined();
  });

  it("passes through when the last human is the target themselves", async () => {
    mockFetchThreadMessages([
      { user: TARGET, text: "anything else?", ts: "1.3" },
    ]);
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      {
        content: `<@${TARGET}> on it`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.0" },
      },
    );
    expect(result).toBeUndefined();
  });

  it("fails open when Slack API returns an error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const result = await callHook(
      { targetUserId: TARGET, botUserId: BOT },
      {
        content: `<@${TARGET}> hi`,
        to: "C123",
        metadata: { channelId: "C123", threadTs: "1.0" },
      },
    );
    expect(result).toBeUndefined();
  });
});
