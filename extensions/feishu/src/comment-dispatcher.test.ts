// Feishu tests cover delivery through the comment event handler.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const createCommentTypingReactionLifecycleMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
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

vi.mock("./monitor.comment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.comment.js")>()),
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./comment-reaction.js", () => ({
  createCommentTypingReactionLifecycle: createCommentTypingReactionLifecycleMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

const commandButton = (label: string, command: string) => ({
  label,
  action: { type: "command" as const, command },
});
const buttons = (...items: Array<ReturnType<typeof commandButton>>) => ({
  blocks: [{ type: "buttons" as const, buttons: items }],
});
const approve = buttons(commandButton("Approve", "/approve req_1"));
const unavailable =
  "> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.";

describe("Feishu comment event reply delivery", () => {
  afterAll(() => {
    vi.doUnmock("./monitor.comment.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./comment-reaction.js");
    vi.doUnmock("./drive.js");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  const cfg: ClawdbotConfig = {
    channels: { feishu: { dmPolicy: "open", allowFrom: ["*"] } },
  };
  let runtime: ReturnType<typeof createPluginRuntimeMock>;

  async function createTestCommentTurn() {
    await handleFeishuCommentEvent({
      cfg,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      accountId: "main",
      event: { event_id: "evt_1" },
    });
    const turn = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0];
    if (!turn) {
      throw new Error("Expected Feishu comment turn");
    }
    return turn;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({});
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      messageId: "drive-comment:evt_1",
      senderId: "ou_sender",
      fileToken: "doc_token_1",
      fileType: "docx",
      commentId: "comment_1",
      replyId: "reply_1",
      isWholeComment: false,
      prompt: "Review this document",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "reply_1",
    });
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    });
    runtime = createPluginRuntimeMock({
      config: { current: () => cfg },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main",
            channel: "feishu",
            accountId: "main",
            sessionKey: "agent:main:feishu:direct:ou_sender",
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "binding.channel",
          }),
        },
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn((): "newline" => "newline"),
          chunkTextWithMode: vi.fn((text: string) => [text]),
        },
      },
    });
    setFeishuRuntime(runtime);
  });

  it("sends final comment text without waiting for typing cleanup", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupPromise = new Promise<void>((resolve) => {
      resolveCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupPromise);
    createCommentTypingReactionLifecycleMock.mockReturnValue({
      start: vi.fn(async () => {}),
      cleanup,
    });

    const created = await createTestCommentTurn();
    const deliverPromise = Promise.resolve(
      created.delivery.deliver({ text: "hello world" }, { kind: "final" }),
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
    expect(cleanup).toHaveBeenCalledTimes(1);

    created.dispatcherOptions?.onCleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(2);

    resolveCleanup?.();
    await deliverPromise;
  });

  it("does not send whitespace-only comment replies without attachments", async () => {
    const created = await createTestCommentTurn();

    const result = await created.delivery.deliver({ text: "  \n\t " }, { kind: "final" });

    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ visibleReplySent: false });
  });

  it.each([
    [
      "caption, actionable presentation, and safe attachment",
      {
        text: "Review this",
        mediaUrl: "https://example.com/attachment.png",
        presentation: approve,
      },
      `Review this\n\n- Approve: \`/approve req_1\`\n\n${unavailable}\n\nhttps://example.com/attachment.png`,
    ],
    [
      "legacy interactive command",
      { interactive: approve },
      `- Approve: \`/approve req_1\`\n\n${unavailable}`,
    ],
    [
      "select option with an actionable command",
      {
        presentation: {
          blocks: [
            {
              type: "select" as const,
              placeholder: "Choose deployment",
              options: [commandButton("Deploy", "/deploy staging")],
            },
          ],
        },
      },
      `Choose deployment:\n- Deploy: \`/deploy staging\`\n\n${unavailable}`,
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
    const created = await createTestCommentTurn();

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
    const created = await createTestCommentTurn();

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

  it("retains the accepted comment reply id and text when a later chunk fails", async () => {
    vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(4);
    vi.mocked(runtime.channel.text.chunkTextWithMode).mockReturnValue(["first", "second"]);
    deliverCommentThreadTextMock
      .mockResolvedValueOnce({ delivery_mode: "reply_comment", reply_id: "reply_native_1" })
      .mockRejectedValueOnce(new Error("second comment send failed"));
    const created = await createTestCommentTurn();

    const error = await Promise.resolve(
      created.delivery.deliver({ text: "firstsecond" }, { kind: "final" }),
    ).catch((caught: unknown) => caught);

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
