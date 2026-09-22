// Line tests cover which admitted messages a later quote can resolve.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setLineRuntime } from "./runtime.js";
import type { LineAccountConfig } from "./types.js";
import { createTestMessageEvent } from "./webhook-spool.test-support.js";

type LineWebhookContext = Parameters<typeof import("./bot-handlers.js").handleLineWebhookEvents>[1];

const { buildLineMessageContextMock, downloadLineMediaMock } = vi.hoisted(() => ({
  buildLineMessageContextMock: vi.fn(),
  downloadLineMediaMock: vi.fn(),
}));

vi.mock("./send.js", () => ({
  getLineGroupName: vi.fn(),
  getUserDisplayName: vi.fn(async (userId: string) => userId),
  pushMessageLine: vi.fn(),
  replyMessageLine: vi.fn(),
}));
vi.mock("./download.js", async (importActual) => ({
  ...(await importActual<typeof import("./download.js")>()),
  downloadLineMedia: downloadLineMediaMock,
}));
// Only the session-backed context build is stubbed; what a quote records comes
// from the real module.
vi.mock("./bot-message-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-message-context.js")>()),
  buildLineMessageContext: buildLineMessageContextMock,
}));

let handleLineWebhookEvents: typeof import("./bot-handlers.js").handleLineWebhookEvents;
let resolveLineQuotedMessage: typeof import("./quoted-messages.js").resolveLineQuotedMessage;

function createContext(params: {
  processMessage: LineWebhookContext["processMessage"];
  requireMention: boolean;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
  turnAdoptionLifecycle?: LineWebhookContext["turnAdoptionLifecycle"];
}): LineWebhookContext {
  const lineConfig: LineAccountConfig = { groupPolicy: "open" };
  return {
    cfg: { channels: { line: lineConfig } },
    account: {
      accountId: "default",
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config",
      config: { ...lineConfig, groups: { "*": { requireMention: params.requireMention } } },
    },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    mediaMaxBytes: 1,
    processMessage: params.processMessage,
    ...(params.groupHistories ? { groupHistories: params.groupHistories } : {}),
    ...(params.historyLimit === undefined ? {} : { historyLimit: params.historyLimit }),
    ...(params.turnAdoptionLifecycle
      ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
      : {}),
  };
}

describe("LINE quotable admitted messages", () => {
  beforeAll(async () => {
    ({ handleLineWebhookEvents } = await import("./bot-handlers.js"));
    ({ resolveLineQuotedMessage } = await import("./quoted-messages.js"));
  });

  beforeEach(() => {
    setLineRuntime(createPluginRuntimeMock());
    buildLineMessageContextMock.mockReset();
    buildLineMessageContextMock.mockImplementation(async () => ({
      ctxPayload: { From: "line:group:group-1" },
      replyToken: "reply-token",
      route: { agentId: "default" },
      isGroup: true,
      accountId: "default",
    }));
    downloadLineMediaMock.mockReset();
  });

  afterAll(() => {
    vi.doUnmock("./send.js");
    vi.doUnmock("./download.js");
    vi.doUnmock("./bot-message-context.js");
    vi.resetModules();
  });

  // A per-group allowFrom narrows an open account to an allowlist. The quote
  // check must see that narrowed gate, not the account-level policy.
  it.each<{ name: string; line: LineAccountConfig; account: LineAccountConfig }>([
    {
      name: "an account allowlist",
      line: { groupPolicy: "allowlist", groupAllowFrom: ["user-3"] },
      account: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["user-3"],
        groups: { "*": { requireMention: false } },
      },
    },
    {
      name: "a per-group allowlist",
      line: { groupPolicy: "open" },
      account: {
        groupPolicy: "open",
        groups: { "group-1": { allowFrom: ["user-3"], requireMention: false } },
      },
    },
  ])("hands $name to the context as the gate that was applied", async ({ line, account }) => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: { id: `m-gate-${line.groupPolicy}`, type: "text", text: "hi", quoteToken: "q-gate" },
      source: { type: "group", groupId: "group-1", userId: "user-3" },
      webhookEventId: `evt-gate-${line.groupPolicy}`,
    });

    await handleLineWebhookEvents([event], {
      cfg: { channels: { line } },
      account: {
        accountId: "default",
        enabled: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        config: account,
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      mediaMaxBytes: 1,
      processMessage,
    });

    // The gate this event was admitted under has to arrive as values, not just
    // as present fields: a quote of an older message re-reads it to decide
    // whether that message's author still passes.
    expect(buildLineMessageContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ groupPolicy: "allowlist", groupAllowFrom: ["user-3"] }),
    );
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "an ambient group message the mention gate skipped", mentioned: false },
    { name: "a mentioned group message that reached the agent", mentioned: true },
  ])("makes $name quotable inside its own conversation", async ({ mentioned }) => {
    const processMessage = vi.fn();
    const groupHistories = new Map<string, HistoryEntry[]>();
    const messageId = mentioned ? "m-dispatched-quotable" : "m-ambient-quotable";
    const text = mentioned ? "@Bot staging is on 10.0.0.5" : "staging is on 10.0.0.5";
    const event = createTestMessageEvent({
      message: {
        id: messageId,
        type: "text",
        text,
        quoteToken: "q-quotable",
        ...(mentioned
          ? {
              mention: {
                mentionees: [{ index: 0, length: 4, type: "user" as const, isSelf: true }],
              },
            }
          : {}),
      },
      source: { type: "group", groupId: "group-ambient", userId: "user-ambient" },
      webhookEventId: `evt-quotable-${messageId}`,
    });

    await handleLineWebhookEvents(
      [event],
      createContext({ processMessage, requireMention: true, groupHistories }),
    );

    // The two record sites write the same fields, so the branch has to be pinned
    // from outside: only the skipped message stays out of the agent turn.
    expect.soft(processMessage).toHaveBeenCalledTimes(mentioned ? 1 : 0);
    expect.soft(groupHistories.get("group-ambient") ?? []).toHaveLength(mentioned ? 0 : 1);
    // The record sites are the only place the conversation is attached, so this
    // is what proves a quote resolves in the group it was written in and nowhere else.
    expect(resolveLineQuotedMessage("default", messageId, "group-ambient")).toEqual({
      fromBot: false,
      body: text,
      senderId: "user-ambient",
    });
    expect(resolveLineQuotedMessage("default", messageId, "group-other")).toBeUndefined();
  });

  it.each([
    { historyLimit: 1, quotable: true },
    { historyLimit: 0, quotable: false },
  ])(
    "records a skipped group message as quotable only while the ambient window holds it (historyLimit $historyLimit)",
    async ({ historyLimit, quotable }) => {
      const processMessage = vi.fn();
      const groupHistories = new Map<string, HistoryEntry[]>();
      const messageId = `m-window-${historyLimit}`;
      const event = createTestMessageEvent({
        message: {
          id: messageId,
          type: "text",
          text: "staging is on 10.0.0.5",
          quoteToken: "q-window",
        },
        source: { type: "group", groupId: "group-window", userId: "user-window" },
        webhookEventId: `evt-window-${historyLimit}`,
      });

      await handleLineWebhookEvents(
        [event],
        createContext({ processMessage, requireMention: true, groupHistories, historyLimit }),
      );

      // Both rows take the skip branch, so the window size alone decides whether the
      // agent will ever see the message, and with it whether a quote may resolve.
      expect.soft(processMessage).not.toHaveBeenCalled();
      expect.soft(groupHistories.get("group-window") ?? []).toHaveLength(quotable ? 1 : 0);
      expect(resolveLineQuotedMessage("default", messageId, "group-window")).toEqual(
        quotable
          ? { fromBot: false, body: "staging is on 10.0.0.5", senderId: "user-window" }
          : undefined,
      );
    },
  );

  it("makes a sticker quotable as the description the agent was given", async () => {
    const processMessage = vi.fn();
    const event = createTestMessageEvent({
      message: {
        id: "m-sticker-quotable",
        type: "sticker",
        packageId: "6136",
        stickerId: "10979904",
        stickerResourceType: "STATIC",
        keywords: ["Thank you", "Thanks", "Grateful"],
        quoteToken: "q-sticker",
      },
      source: { type: "group", groupId: "group-sticker", userId: "user-sticker" },
      webhookEventId: "evt-sticker-quotable",
    });

    await handleLineWebhookEvents(
      [event],
      createContext({ processMessage, requireMention: false }),
    );

    // A quote has to answer with what the reader already saw. The agent is given
    // LINE's own keywords for a sticker, so `<sticker>` would be a second, poorer
    // rendering of a message the turn already described.
    expect(resolveLineQuotedMessage("default", "m-sticker-quotable", "group-sticker")).toEqual({
      fromBot: false,
      body: "[Sent a sticker: Thank you, Thanks, Grateful]",
      senderId: "user-sticker",
    });
  });

  it("makes every image of a multi-image send quotable, not just the part that anchored it", async () => {
    downloadLineMediaMock.mockImplementation(async (messageId: string) => ({
      path: `/media/${messageId}.png`,
      contentType: "image/png",
      size: 10,
    }));
    const processMessage = vi.fn();
    const imagePart = (messageId: string, index: number) =>
      createTestMessageEvent({
        message: {
          id: messageId,
          type: "image",
          contentProvider: { type: "line" },
          quoteToken: `q-${messageId}`,
          imageSet: { id: "image-set-quotable", index, total: 3 },
        },
        source: { type: "group", groupId: "group-set-quotable", userId: "user-set" },
        webhookEventId: `evt-set-quotable-${index}`,
      });

    // LINE delivers the parts out of order; the turn is anchored on whichever came first.
    await handleLineWebhookEvents(
      [imagePart("m-set-2", 2), imagePart("m-set-1", 1), imagePart("m-set-3", 3)],
      createContext({
        processMessage,
        requireMention: false,
        turnAdoptionLifecycle: {
          admission: "exclusive",
          onAdopted: vi.fn(async () => {}),
          onDeferred: vi.fn(() => {}),
          onAbandoned: vi.fn(async () => {}),
          abortSignal: new AbortController().signal,
        },
      }),
    );

    expect(processMessage).toHaveBeenCalledTimes(1);
    for (const messageId of ["m-set-1", "m-set-2", "m-set-3"]) {
      expect(resolveLineQuotedMessage("default", messageId, "group-set-quotable")).toEqual({
        fromBot: false,
        body: "<image>",
        senderId: "user-set",
      });
    }
  });
});
