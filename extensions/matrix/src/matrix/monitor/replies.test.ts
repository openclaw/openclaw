import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { prepareMatrixReplyPayload } from "../../outbound.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixSendResult } from "../send/types.js";

type MatrixSend = typeof import("../send.js").sendMessageMatrix;
const sendMessageMatrixMock = vi.hoisted(() => vi.fn<MatrixSend>());

// mock-isolation: delivery fixtures record sends without starting a Matrix transport.
vi.mock("../send.js", () => ({
  sendMessageMatrix: sendMessageMatrixMock,
}));

import { setMatrixRuntime } from "../../runtime.js";
import {
  createMatrixTestReplyDispatcher,
  type MatrixTestReplyOptions,
} from "./reply-dispatcher.test-support.js";

let nextMessageId = 0;

const resolveMockMatrixSend: MatrixSend = async (_to, message, opts) => {
  nextMessageId += 1;
  const messageId = `mx-${nextMessageId}`;
  const content = message || `media:${opts.mediaUrl ?? "unknown"}`;
  const result: MatrixSendResult = {
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
  await opts.onDeliveryResult?.(result);
  return result;
};

function sendCall(index: number) {
  const call = sendMessageMatrixMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected send call at index ${index}`);
  }
  return call;
}

function sendOptions(index: number) {
  return sendCall(index)[2];
}

describe("Matrix reply dispatcher delivery", () => {
  const PRESENTATION_KEY = "com.openclaw.presentation";
  const cfg = { channels: { matrix: {} } };

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  async function createDispatcher(options: Partial<MatrixTestReplyOptions> = {}) {
    return createMatrixTestReplyDispatcher({
      cfg,
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
      ...options,
    });
  }

  async function deliver(options: Partial<MatrixTestReplyOptions> & { replies: ReplyPayload[] }) {
    const dispatcher = await createDispatcher(options);
    const results = [];
    for (const reply of options.replies) {
      results.push(await dispatcher.deliverReply(reply, { kind: "final" }));
    }
    return results.at(-1);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    nextMessageId = 0;
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
    setMatrixRuntime({ logging: { shouldLogVerbose: () => false } } as unknown as PluginRuntime);
  });

  function deliverTexts(texts: string[]) {
    return deliver({ replies: texts.map((text) => ({ text })), roomId: "room:5" });
  }

  it("does not consume the first reply when Matrix delivery fails", async () => {
    const dispatcher = await createDispatcher({
      roomId: "room:1",
      replyToMode: "first",
      replyToEventId: "reply-1",
    });
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("Matrix unavailable"));
    await expect(dispatcher.deliverReply({ text: "retry me" }, { kind: "final" })).rejects.toThrow(
      "Matrix unavailable",
    );
    await expect(
      dispatcher.deliverReply({ text: "retry me" }, { kind: "final" }),
    ).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(1).replyToId).toBe("reply-1");
  });

  it.each([undefined, "   "])("reports blank-only media with text=%j as missing", async (text) => {
    const result = await deliver({ replies: [{ text, mediaUrls: ["   "] }] });
    expect(runtimeEnv.error).toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliverTexts([
      "Reasoning:\n_hidden_",
      "<think>still hidden</think>",
      "<mm:think>MiniMax private reasoning</mm:think>",
      "<mm:thought>MiniMax private thought</mm:thought>",
      "<antml:thinking>Anthropic private reasoning</antml:thinking>",
      "Visible answer",
    ]);
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[0]).toBe("room:5");
    expect(sendCall(0)[1]).toBe("Visible answer");
    expect(sendOptions(0).cfg).toBe(cfg);
  });

  it.each([false, true])(
    "gates suppression diagnostics through runtime.log with verbose=%s",
    async (verbose) => {
      setMatrixRuntime(createPluginRuntimeMock({ logging: { shouldLogVerbose: () => verbose } }));
      await deliverTexts(["Reasoning: private"]);
      expect(runtimeEnv.log).toHaveBeenCalledTimes(verbose ? 1 : 0);
      if (verbose) {
        expect(runtimeEnv.log).toHaveBeenCalledWith("matrix reply suppressed as reasoning-only");
      }
      expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    },
  );

  it("strips namespaced reasoning while delivering visible Matrix replies", async () => {
    const cases = [
      ["<mm:think>private</mm:think>MiniMax answer", "MiniMax answer"],
      ["<antml:thinking>private</antml:thinking>Answer", "Answer"],
      ["<br>HTML answer<mm:think>private</mm:think>", "<br>HTML answer"],
      ["Safe answer<mm:think>unfinished", "Safe answer"],
      ["Answer<think>old</think><think>unfinished", "Answer"],
      ["<thinking>private</think>Alias answer", "Alias answer"],
      ["<final>Final answer", "Final answer"],
    ] as const;
    await deliverTexts(cases.map(([text]) => text));
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(cases.length);
    expect(sendMessageMatrixMock.mock.calls.map((call) => call[1])).toEqual(
      cases.map(([, text]) => text),
    );
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

  async function deliverPresentation(
    reply: ReplyPayload,
    blocks: NonNullable<ReplyPayload["presentation"]>["blocks"],
  ) {
    return deliver({
      replies: [await prepareMatrixReplyPayload({ ...reply, presentation: { blocks } })],
    });
  }

  it("attaches the controls to the first event of a reply that carries media", async () => {
    await deliverPresentation(
      {
        text: "Pick one",
        mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
      },
      [
        { type: "text", text: "Deploy to production?" },
        {
          type: "buttons",
          buttons: [{ label: "Approve", action: { type: "callback", value: "approve" } }],
        },
      ],
    );
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendOptions(0).extraContent).toHaveProperty(PRESENTATION_KEY, expect.anything());
    expect(sendOptions(1).extraContent).toBeUndefined();
  });

  const authoredText =
    "Status: ok\nUptime: 42s\nReference UTC: 12:00\n\n| agent | state |\n| --- | --- |\n| main | idle |";
  it.each([false, true])("preserves presentation fallback (native context: %s)", async (native) => {
    const blocks: NonNullable<ReplyPayload["presentation"]>["blocks"] = [
      { type: "context", text: native ? "took 42s" : "Status: ok · Uptime: 42s" },
    ];
    if (!native) {
      blocks.push({
        type: "table",
        caption: "Agents",
        headers: ["agent", "state"],
        rows: [["main", "idle"]],
      });
    }
    await deliverPresentation(
      {
        text: native ? "Deploy finished." : authoredText,
        presentationTextMode: "fallback",
      },
      blocks,
    );
    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toEqual(native ? expect.stringContaining("took 42s") : authoredText);
    expect(sendOptions(0).extraContent).toEqual(
      native
        ? expect.objectContaining({
            [PRESENTATION_KEY]: expect.objectContaining({
              type: "message.presentation",
              version: 1,
            }),
          })
        : undefined,
    );
  });
});
