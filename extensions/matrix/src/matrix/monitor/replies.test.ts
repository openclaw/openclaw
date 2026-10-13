import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";

let nextMessageId = 0;

async function resolveMockMatrixSend(_to: string, message: string, opts?: Record<string, unknown>) {
  nextMessageId += 1;
  const messageId = `mx-${nextMessageId}`;
  const mediaUrl = typeof opts?.mediaUrl === "string" ? opts.mediaUrl : "unknown";
  const content = message || `media:${mediaUrl}`;
  const result = {
    messageId,
    roomId: "room:1",
    primaryMessageId: messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    content,
  };
  const onDeliveryResult = opts?.onDeliveryResult;
  if (typeof onDeliveryResult === "function") {
    await onDeliveryResult(result);
  }
  return result;
}

function sendCall(index: number) {
  const call = sendMessageMatrixMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected send call at index ${index}`);
  }
  return call;
}

function sendOptions(index: number): Record<string, unknown> {
  const options = sendCall(index)[2];
  if (!options || typeof options !== "object") {
    throw new Error(`Expected send options at call ${index}`);
  }
  return options as Record<string, unknown>;
}

describe("deliverMatrixReplies", () => {
  const PRESENTATION_KEY = "com.openclaw.presentation";
  const cfg = { channels: { matrix: {} } };
  const runtimeStub = {
    config: { current: () => ({}) },
    channel: {
      text: {
        resolveMarkdownTableMode: () => "code",
        resolveTextChunkLimit: () => 4000,
        convertMarkdownTables: (text: string) => text,
        resolveChunkMode: () => "length",
        chunkMarkdownTextWithMode: (text: string) => [text],
      },
    },
    logging: { shouldLogVerbose: () => false },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  function deliver(
    options: Pick<Parameters<typeof deliverMatrixReplies>[0], "replies"> &
      Partial<Parameters<typeof deliverMatrixReplies>[0]>,
  ) {
    return deliverMatrixReplies({
      cfg,
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      ...options,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    nextMessageId = 0;
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
    setMatrixRuntime(runtimeStub);
  });

  it("encodes an explicit reply tag in the actual Matrix provider relation", async () => {
    const actualSend = await vi.importActual<typeof import("../send.js")>("../send.js");
    sendMessageMatrixMock.mockImplementation(actualSend.sendMessageMatrix);
    const sendMessage = vi.fn(
      async (_roomId: string, _content: Record<string, unknown>) => "$sent",
    );
    const client = {
      sendMessage,
      prepareRoomForMessageSend: async () => "m.room.message",
      getJoinedRoomMembers: async () => [],
      getUserId: async () => "@bot:example.org",
    } as unknown as MatrixClient;
    const result = await deliver({
      replies: [{ text: "hello", replyToId: "$chosen", replyToTag: true }],
      roomId: "!room:example.org",
      client,
      replyToId: "$ambient",
    });
    expect(result.visibleReplySent).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[1]["m.relates_to"]).toEqual({
      "m.in_reply_to": { event_id: "$chosen" },
    });
  });

  it("does not consume the first reply when Matrix delivery fails", async () => {
    const hasRepliedRef = { value: false };
    const delivery = {
      cfg,
      replies: [{ text: "retry me" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "first" as const,
      replyToId: "reply-1",
      hasRepliedRef,
    };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("Matrix unavailable"));

    await expect(deliverMatrixReplies(delivery)).rejects.toThrow("Matrix unavailable");
    expect(hasRepliedRef.value).toBe(false);

    await expect(deliverMatrixReplies(delivery)).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(1).replyToId).toBe("reply-1");
    expect(hasRepliedRef.value).toBe(true);
  });

  it("reports blank-only media as missing instead of silently suppressing it", async () => {
    const result = await deliver({
      replies: [{ mediaUrls: ["   "] }],
    });

    expect(runtimeEnv.error).toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("reports blank text with blank-only media as missing", async () => {
    const result = await deliver({
      replies: [{ text: "   ", mediaUrls: ["   "] }],
    });

    expect(runtimeEnv.error).toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliver({
      replies: [
        { text: "Reasoning:\n_hidden_" },
        { text: "<think>still hidden</think>" },
        { text: "<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "<mm:thought>MiniMax private thought</mm:thought>" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>" },
        { text: "Visible answer" },
      ],
      roomId: "room:5",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[0]).toBe("room:5");
    expect(sendCall(0)[1]).toBe("Visible answer");
    expect(sendOptions(0).cfg).toBe(cfg);
  });

  it("strips namespaced reasoning while delivering visible Matrix replies", async () => {
    await deliver({
      replies: [
        { text: "<mm:think>MiniMax private reasoning</mm:think>Visible MiniMax answer" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>Visible answer" },
        { text: "<br>Visible HTML answer<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "Visible safe answer<mm:think>unfinished private reasoning" },
        { text: "Visible answer<think>old reasoning</think><think>unfinished private reasoning" },
        { text: "<thinking>private reasoning</think>Visible alias answer" },
        { text: "<final>Visible final answer" },
      ],
      roomId: "room:5",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(7);
    expect(sendCall(0)[1]).toBe("Visible MiniMax answer");
    expect(sendCall(1)[1]).toBe("Visible answer");
    expect(sendCall(2)[1]).toBe("<br>Visible HTML answer");
    expect(sendCall(3)[1]).toBe("Visible safe answer");
    expect(sendCall(4)[1]).toBe("Visible answer");
    expect(sendCall(5)[1]).toBe("Visible alias answer");
    expect(sendCall(6)[1]).toBe("Visible final answer");
  });

  it("delivers Matrix media without a reasoning-only caption", async () => {
    await deliver({
      replies: [
        {
          text: "<mm:think>MiniMax private reasoning</mm:think>",
          mediaUrl: "https://example.com/a.jpg",
        },
      ],
      roomId: "room:5",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe("");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
  });

  const deliverPresentation = async (reply: ReplyPayload) =>
    await deliver({ replies: [await prepareMatrixReplyPayload(reply)] });

  const approvalPresentation = {
    blocks: [
      { type: "text" as const, text: "Deploy to production?" },
      {
        type: "buttons" as const,
        buttons: [
          { label: "Approve", action: { type: "callback" as const, value: "approve" } },
          { label: "Deny", action: { type: "callback" as const, value: "deny" } },
        ],
      },
    ],
  };

  it("attaches the controls to the first event of a reply that carries media", async () => {
    await deliverPresentation({
      text: "Pick one",
      mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      presentation: approvalPresentation,
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    const first = sendMessageMatrixMock.mock.calls[0]?.[2] as Record<string, unknown>;
    const second = sendMessageMatrixMock.mock.calls[1]?.[2] as Record<string, unknown>;
    expect((first.extraContent as Record<string, unknown>)[PRESENTATION_KEY]).toBeDefined();
    expect(second.extraContent).toBeUndefined();
  });

  it("sends the authored text once when the presentation only restates it", async () => {
    // `/status` curates table/context facts into prose with extra diagnostics.
    // Native context support must not replace that authored fallback when tables degrade.
    const authoredText =
      "Status: ok\nUptime: 42s\nReference UTC: 12:00\n\n| agent | state |\n| --- | --- |\n| main | idle |";
    await deliverPresentation({
      text: authoredText,
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "context", text: "Status: ok · Uptime: 42s" },
          {
            type: "table",
            caption: "Agents",
            headers: ["agent", "state"],
            rows: [["main", "idle"]],
          },
        ],
      },
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toBe(authoredText);
    expect(opts.extraContent).toBeUndefined();
  });

  it("keeps a context block Matrix renders natively in the event", async () => {
    // Matrix advertises context support, so a context-only presentation is not the
    // fully-degraded case that lets the producer's own prose stand alone.
    await deliverPresentation({
      text: "Deploy finished.",
      presentationTextMode: "fallback",
      presentation: {
        blocks: [{ type: "context", text: "took 42s" }],
      },
    });

    const [, text, opts] = sendMessageMatrixMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(text).toContain("took 42s");
    expect((opts.extraContent as Record<string, unknown>)[PRESENTATION_KEY]).toMatchObject({
      type: "message.presentation",
      version: 1,
    });
  });
});
