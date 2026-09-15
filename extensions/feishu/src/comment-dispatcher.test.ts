// Feishu tests cover comment dispatcher plugin behavior.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuRuntimeAccountMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createReplyPrefixContextMock = vi.hoisted(() => vi.fn());
const createCommentTypingReactionLifecycleMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "private.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return { hostname, addresses: ["93.184.216.34"], lookup: vi.fn() };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: resolveFeishuRuntimeAccountMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>()),
  createReplyPrefixContext: createReplyPrefixContextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: createCommentTypingReactionLifecycleMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: getFeishuRuntimeMock,
}));
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

describe("createFeishuCommentReplyDispatcher", () => {
  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-outbound");
    vi.doUnmock("./comment-reaction.js");
    vi.doUnmock("./drive.js");
    vi.doUnmock("./runtime.js");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  function createTestCommentReplyDispatcher() {
    return createFeishuCommentReplyDispatcher({
      cfg: {} as never,
      agentId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      accountId: "main",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
    });
  }

  function replyDispatcherOptions(created: ReturnType<typeof createFeishuCommentReplyDispatcher>) {
    return {
      ...created.dispatcherOptions,
      deliver: created.delivery.deliver,
    } as {
      deliver: (payload: { text: string }, phase: { kind: string }) => Promise<unknown>;
      onCleanup?: () => Promise<void> | void;
      onReplyStart?: () => Promise<void> | void;
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveFeishuRuntimeAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {},
    });
    createFeishuClientMock.mockReturnValue({});
    createReplyPrefixContextMock.mockReturnValue({
      responsePrefix: undefined,
      responsePrefixContextProvider: undefined,
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup,
    });

    const created = createTestCommentReplyDispatcher();
    const options = replyDispatcherOptions(created);
    const deliverPromise = Promise.resolve(
      options.deliver({ text: "hello world" }, { kind: "final" }),
    );
    const status = await raceWithNextMacrotask(deliverPromise.then(() => "done"));

    expect(status).toBe("done");
    const client = createFeishuClientMock.mock.results[0]?.value;
    if (!client) {
      throw new Error("Expected Feishu client");
    }
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(client, {
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: "hello world",
      is_whole_comment: false,
    });
    expect(cleanup).not.toHaveBeenCalled();

    void options.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await deliverPromise;
  });

  it("starts the typing reaction from dispatcher onReplyStart", async () => {
    const start = vi.fn(async () => {});
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start,
      cleanup: vi.fn(async () => {}),
    });

    const created = createTestCommentReplyDispatcher();
    const options = replyDispatcherOptions(created);
    await options.onReplyStart?.();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not send whitespace-only comment replies without attachments", async () => {
    const created = createTestCommentReplyDispatcher();

    const result = await created.delivery.deliver({ text: "  \n\t " }, { kind: "final" });

    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ visibleReplySent: false });
  });

  it.each([
    [
      "media-only singular",
      { mediaUrl: "https://example.com/only.png" },
      "https://example.com/only.png",
    ],
    [
      "caption and multiple ordered attachments",
      {
        text: "see attachments",
        mediaUrls: [" https://example.com/first.png ", "", "https://example.com/second.png"],
      },
      "see attachments\n\nhttps://example.com/first.png\n\nhttps://example.com/second.png",
    ],
    [
      "singular fallback when plural entries are blank",
      { mediaUrls: [" "], mediaUrl: "https://example.com/fallback.png" },
      "https://example.com/fallback.png",
    ],
    [
      "presentation-only actionable command",
      {
        presentation: {
          title: "Deployment",
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Approve",
                  action: { type: "command" as const, command: "/approve req_1" },
                },
              ],
            },
          ],
        },
      },
      "Deployment\n\n- Approve: `/approve req_1`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    ],
    [
      "caption, actionable presentation, and safe attachment",
      {
        text: "Review this",
        mediaUrl: "https://example.com/attachment.png",
        presentation: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Approve",
                  action: { type: "command" as const, command: "/approve req_1" },
                },
              ],
            },
          ],
        },
      },
      "Review this\n\n- Approve: `/approve req_1`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.\n\nhttps://example.com/attachment.png",
    ],
    [
      "legacy interactive command",
      {
        interactive: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Approve",
                  action: { type: "command" as const, command: "/approve req_1" },
                },
              ],
            },
          ],
        },
      },
      "- Approve: `/approve req_1`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    ],
    [
      "select option with an actionable command",
      {
        presentation: {
          blocks: [
            {
              type: "select" as const,
              placeholder: "Choose deployment",
              options: [
                {
                  label: "Deploy",
                  action: { type: "command" as const, command: "/deploy staging" },
                },
              ],
            },
          ],
        },
      },
      "Choose deployment:\n- Deploy: `/deploy staging`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    ],
    [
      "select callback without actionable guidance",
      {
        presentation: {
          blocks: [
            {
              type: "select" as const,
              options: [
                {
                  label: "Choose",
                  action: { type: "callback" as const, value: "private_choice" },
                },
              ],
            },
          ],
        },
      },
      "Options:\n- Choose",
    ],
    [
      "disabled command without actionable guidance",
      {
        presentation: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Disabled",
                  disabled: true,
                  action: { type: "command" as const, command: "/approve req_1" },
                },
              ],
            },
          ],
        },
      },
      "- Disabled",
    ],
    [
      "URL-only button without actionable guidance",
      {
        presentation: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                {
                  label: "Open",
                  action: { type: "url" as const, url: "https://example.com/action" },
                },
              ],
            },
          ],
        },
      },
      "- Open: https://example.com/action",
    ],
  ])("delivers %s as safe plain-text comment links", async (_label, payload, expected) => {
    const created = createTestCommentReplyDispatcher();

    const result = await created.delivery.deliver(payload, { kind: "final" });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: expected }),
    );
    expect(result).toMatchObject({ content: expected, visibleReplySent: true });
  });

  it.each([
    ["local path", "/private/tmp/voice.mp3"],
    ["loopback URL", "http://127.0.0.1:3000/voice.mp3"],
    ["private DNS", "https://private.example.test/voice.mp3"],
    ["credentialed URL", "https://operator:secret@example.com/voice.mp3"],
  ])("does not disclose a %s in comment reply media fallbacks", async (_label, mediaUrl) => {
    const created = createTestCommentReplyDispatcher();

    const result = await created.delivery.deliver({ mediaUrl }, { kind: "final" });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: "Media upload failed. Please try again." }),
    );
    expect(result).toMatchObject({
      content: "Media upload failed. Please try again.",
      visibleReplySent: true,
    });
    expect(deliverCommentThreadTextMock.mock.calls[0]?.[1]?.content).not.toContain(mediaUrl);
  });

  it("chunks the transformed comment text including attachment links", async () => {
    const chunkMarkdownTextWithMode = vi.fn((text: string) =>
      Array.from({ length: Math.ceil(text.length / 12) }, (_value, index) =>
        text.slice(index * 12, (index + 1) * 12),
      ),
    );
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 12),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          chunkMarkdownTextWithMode,
        },
      },
    });
    const expected = "caption\n\nhttps://example.com/file.png";
    const created = createTestCommentReplyDispatcher();

    const result = await created.delivery.deliver(
      { text: "caption", mediaUrl: "https://example.com/file.png" },
      { kind: "final" },
    );

    expect(chunkMarkdownTextWithMode).toHaveBeenCalledWith(expected, 12, "line");
    expect(
      deliverCommentThreadTextMock.mock.calls.every((call) => call[1].content.length <= 12),
    ).toBe(true);
    expect(result).toMatchObject({ content: expected, visibleReplySent: true });
  });

  describe("markdown table modes", () => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    let actual: typeof import("openclaw/plugin-sdk/markdown-table-runtime");

    beforeEach(async () => {
      actual = await vi.importActual<typeof import("openclaw/plugin-sdk/markdown-table-runtime")>(
        "openclaw/plugin-sdk/markdown-table-runtime",
      );
      const runtime = getFeishuRuntimeMock();
      getFeishuRuntimeMock.mockReturnValue({
        ...runtime,
        channel: {
          ...runtime.channel,
          text: {
            ...runtime.channel.text,
            resolveMarkdownTableMode: actual.resolveMarkdownTableMode,
            convertMarkdownTables: actual.convertMarkdownTables,
          },
        },
      });
      // Feishu declares block as its plugin default; the harness registers the
      // same meta because it does not load the runtime setup.
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: {
              id: "feishu",
              meta: { id: "feishu" },
              messaging: { defaultMarkdownTableMode: "block" },
            },
          },
        ]),
      );
    });

    afterEach(() => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
    });

    it.each(["bullets", "code", undefined, "off"] as const)(
      "converts a table before comment delivery in %s mode",
      async (tables: MarkdownTableMode | undefined) => {
        const expected =
          tables === "off"
            ? tableMarkdown
            : actual.convertMarkdownTables(
                tableMarkdown,
                tables === "bullets" ? "bullets" : "code",
              );
        const created = createFeishuCommentReplyDispatcher({
          cfg: (tables ? { channels: { feishu: { markdown: { tables } } } } : {}) as never,
          agentId: "main",
          runtime: { log: vi.fn(), error: vi.fn() } as never,
          accountId: "main",
          fileToken: "doc_token_1",
          fileType: "docx",
          commentId: "comment_1",
          replyId: "reply_1",
          isWholeComment: false,
        });

        await replyDispatcherOptions(created).deliver({ text: tableMarkdown }, { kind: "final" });

        expect(deliverCommentThreadTextMock.mock.calls[0]?.[1]?.content).toBe(expected);
      },
    );

    // A converted table is one fenced block, so the chunker that splits it has to
    // close and reopen the fence instead of cutting the block in half. This covers an
    // ordinary table at a workable limit, in both real chunk modes. A limit too small to
    // hold a marker pair, or a marker grown long by backticks inside a cell, still falls
    // back to a raw boundary in the core chunker and is not repaired here.
    it.each(["length", "newline"] as const)(
      "balances the fences of an oversized converted table in %s mode",
      async (chunkMode) => {
        const chunking = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-chunking")>(
          "openclaw/plugin-sdk/reply-chunking",
        );
        const limit = 200;
        const wideTable = [
          "| Name | Role |",
          "| --- | --- |",
          ...Array.from(
            { length: 14 },
            (_value, index) => `| Member ${index} | Engineer ${index} |`,
          ),
        ].join("\n");
        const runtime = getFeishuRuntimeMock();
        getFeishuRuntimeMock.mockReturnValue({
          ...runtime,
          channel: {
            ...runtime.channel,
            text: {
              ...runtime.channel.text,
              resolveTextChunkLimit: vi.fn(() => limit),
              resolveChunkMode: vi.fn(() => chunkMode),
              chunkTextWithMode: chunking.chunkTextWithMode,
              chunkMarkdownTextWithMode: chunking.chunkMarkdownTextWithMode,
            },
          },
        });
        const created = createTestCommentReplyDispatcher();

        await replyDispatcherOptions(created).deliver({ text: wideTable }, { kind: "final" });

        const contents = deliverCommentThreadTextMock.mock.calls.map(
          (call) => call[1].content as string,
        );
        expect(actual.convertMarkdownTables(wideTable, "code").length).toBeGreaterThan(limit);
        // Keeping the block whole by widening the limit would hide the split, not repair it.
        expect(contents.length).toBeGreaterThan(1);
        for (const content of contents) {
          expect(content.length).toBeLessThanOrEqual(limit);
          expect((content.match(/^`{3,}/gm)?.length ?? 0) % 2).toBe(0);
        }
      },
    );
  });

  it("retains the accepted comment reply id and text when a later chunk fails", async () => {
    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
          convertMarkdownTables: vi.fn((text: string) => text),
          chunkMarkdownTextWithMode: vi.fn(() => ["first", "second"]),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_native_1" })
      .mockRejectedValueOnce(new Error("second comment send failed"));
    const created = createTestCommentReplyDispatcher();

    const error = await created.delivery
      .deliver({ text: "firstsecond" }, { kind: "final" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["reply_native_1"],
        content: "first",
        visibleReplySent: true,
      },
    });
  });
});
