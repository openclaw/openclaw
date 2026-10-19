import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { deleteQaBusMessage, editQaBusMessage, sendQaBusMessage } from "./bus-client.js";
import { qaChannelPlugin } from "./channel.js";
import { handleQaInbound } from "./inbound.js";
import {
  createQaInboundParams,
  firstRunAssembledParams,
  runQaInbound,
  startQaInbound,
} from "./inbound.test-harness.js";

const QA_GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0nQAAAAASUVORK5CYII=";
const imageAnswer = { text: "single answer", mediaUrl: "/tmp/answer.png" };
type Attachment = NonNullable<
  Parameters<typeof handleQaInbound>[0]["message"]["attachments"]
>[number];

function generatedImage(fileName?: string) {
  return {
    buffer: Buffer.from(QA_GENERATED_IMAGE_BASE64, "base64"),
    kind: "image" as const,
    contentType: "image/png",
    fileName,
  };
}

vi.mock("./bus-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bus-client.js")>();
  return {
    ...actual,
    deleteQaBusMessage: vi.fn(async () => ({ message: {} })),
    editQaBusMessage: vi.fn(async () => ({ message: {} })),
    sendQaBusMessage: vi.fn(async () => ({ message: { id: "preview-1" } })),
  };
});

vi.mock("openclaw/plugin-sdk/outbound-media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/outbound-media")>();
  return {
    ...actual,
    loadOutboundMediaFromUrl: vi.fn(async (mediaUrl: string) =>
      generatedImage(path.basename(mediaUrl)),
    ),
  };
});

vi.mock("openclaw/plugin-sdk/media-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-store")>()),
  saveMediaBuffer: vi.fn(async () => ({
    id: "stored-audio.ogg",
    path: "/tmp/openclaw-media/stored-audio.ogg",
    contentType: "audio/ogg",
  })),
}));

describe("handleQaInbound", () => {
  let runtime: ReturnType<typeof createPluginRuntimeMock>;
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createPluginRuntimeMock();
    setQaChannelRuntime(runtime);
  });
  afterEach(() => vi.restoreAllMocks());

  function receive(overrides: Parameters<typeof createQaInboundParams>[0]) {
    return handleQaInbound(createQaInboundParams(overrides));
  }
  function receiveAttachments(...attachments: Attachment[]) {
    return receive({ message: { attachments } });
  }

  it("uses one session for inbound channel threads and explicit thread replies", async () => {
    await receive({
      message: {
        conversation: { id: "qa-room", kind: "channel" },
        threadId: "42",
      },
    });

    const assembled = firstRunAssembledParams(runtime);
    const outboundRoute = await qaChannelPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "thread:qa-room/42",
    });

    expect(outboundRoute?.sessionKey).toBe(assembled.route.sessionKey);
  });

  it("treats deliveries without dispatcher metadata as final replies", async () => {
    const assembled = await assembledTurn(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    const missingDeliveryInfo = undefined as unknown as Parameters<
      typeof assembled.delivery.deliver
    >[1];
    await assembled.delivery.deliver({ text: "final answer" }, missingDeliveryInfo);

    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "preview-1", text: "final answer" }),
    );
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("keeps block deliveries separate and retains tool calls discovered after a preview", async () => {
    await startQaInbound(runtime, createQaInboundParams());

    const assembled = firstRunAssembledParams(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "preview" });
    await assembled.replyOptions?.onToolStart?.({
      phase: "start",
      name: "search",
      args: { query: "qa" },
    });
    await assembled.delivery.deliver({ text: "tool result" }, { kind: "block" });
    await assembled.delivery.deliver({ text: "final answer" }, { kind: "final" });

    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledTimes(3);
    expect(sendQaBusMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: "tool result",
        toolCalls: [{ name: "search", arguments: { query: "qa" } }],
      }),
    );
    expect(sendQaBusMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        text: "final answer",
        toolCalls: [{ name: "search", arguments: { query: "qa" } }],
      }),
    );
  });

  it("does not suppress the final caption after a failed media delivery", async () => {
    const assembled = await assembledTurn(runtime);
    vi.mocked(loadOutboundMediaFromUrl).mockRejectedValueOnce(new Error("media too large"));
    await expect(assembled.delivery.deliver(imageAnswer, { kind: "block" })).rejects.toThrow(
      "media too large",
    );
    expect(sendQaBusMessage).not.toHaveBeenCalled();
    await assembled.delivery.deliver({ text: "single answer" }, { kind: "final" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expectSend(1, { text: "single answer" });
  });

  it("keeps captionless media and a subsequent text final", async () => {
    const assembled = await assembledTurn(runtime);
    await assembled.delivery.deliver({ mediaUrl: "/tmp/answer.png" }, { kind: "block" });
    await assembled.delivery.deliver({ text: "single answer" }, { kind: "final" });
    expect(sendQaBusMessage).toHaveBeenCalledTimes(2);
    expectSend(1, {
      text: "",
      attachments: [expect.objectContaining({ contentBase64: QA_GENERATED_IMAGE_BASE64 })],
    });
    expectSend(2, { text: "single answer" });
  });

  it("retains tool calls started while media is loading in the later final", async () => {
    const assembled = await assembledTurn(runtime);
    await assembled.replyOptions?.onToolStart?.({ phase: "start", name: "image" });
    vi.mocked(loadOutboundMediaFromUrl).mockImplementationOnce(async () => {
      await assembled.replyOptions?.onToolStart?.({ phase: "start", name: "search" });
      return generatedImage();
    });
    await assembled.delivery.deliver(imageAnswer, { kind: "block" });
    await assembled.delivery.deliver({ text: "single answer" }, { kind: "final" });
    expect(sendQaBusMessage).toHaveBeenCalledTimes(2);
    expectSend(1, { toolCalls: [{ name: "image" }] });
    expectSend(2, { toolCalls: [{ name: "image" }, { name: "search" }] });
  });

  it("suppresses an identical final with the same tool-call trace", async () => {
    const assembled = await assembledTurn(runtime);
    await assembled.replyOptions?.onToolStart?.({
      phase: "start",
      name: "search",
      args: { second: 2, first: 1 },
    });
    await assembled.delivery.deliver({ text: "single answer" }, { kind: "block" });
    await assembled.delivery.deliver({ text: "single answer" }, { kind: "final" });

    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("escapes control characters in dispatch error logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(deleteQaBusMessage).mockRejectedValueOnce(
      new Error("cleanup\nforged\u001b[31m\u009b32m\u2028next"),
    );
    const assembled = await assembledTurn(runtime);
    await assembled.replyOptions?.onPartialReply?.({ text: "unfinished preview" });
    assembled.delivery.onError?.(new Error("dispatch\r\nforged\u2029next"), {
      kind: "final",
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    assembled.delivery.onError?.(undefined, { kind: "final" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));
    const output = warn.mock.calls.flat().join(" ");
    expect(
      ["\r", "\n", "\u001b", "\u009b", "\u2028", "\u2029"].filter((char) => output.includes(char)),
    ).toEqual([]);
    expect(output).toContain("dispatch\\u000d\\u000aforged\\u2029next");
    expect(output).toContain("cleanup\\u000aforged\\u001b[31m\\u009b32m\\u2028next");
    expect(output).toContain("reply dispatch failed: undefined");
  });

  it("drops direct messages outside the configured sender allowlist", async () => {
    await receive({ accountConfig: { allowFrom: ["bob"] } });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("allows direct messages from configured senders", async () => {
    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          allowFrom: ["alice"],
        },
      }),
    );

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    const ctxPayload = firstRunAssembledParams(runtime).ctxPayload;
    expect(ctxPayload?.CommandAuthorized).toBe(true);
    expect(ctxPayload?.SenderId).toBe("alice");
  });

  it("preserves the complete native command in its slash session", async () => {
    const text = "/think high";

    await receive({ message: { text, nativeCommand: { name: "think" } } });

    const assembled = firstRunAssembledParams(runtime);
    expect(assembled.ctxPayload).toMatchObject({
      BodyForCommands: text,
      CommandAuthorized: true,
      CommandBody: text,
      CommandSource: "native",
      CommandTargetSessionKey: assembled.route.sessionKey,
      CommandTurn: { body: text, source: "native" },
    });
    expect(assembled.ctxPayload.SessionKey).toContain("qa-channel:slash:alice");
    expect(assembled.ctxPayload.SessionKey).not.toBe(assembled.route.sessionKey);
  });

  it("skips malformed inline attachment base64 without dropping the message", async () => {
    await receiveAttachments(attachment({ contentBase64: "AAA@@@" }));

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    const ctxPayload = firstRunAssembledParams(runtime).ctxPayload;
    expect(ctxPayload.media?.every((fact) => fact.path === undefined)).toBe(true);
  });

  it("projects saved inline attachments through a media-store URL", async () => {
    await receiveAttachments(
      attachment({
        id: "audio-1",
        kind: "audio",
        mimeType: "audio/ogg",
        contentBase64: Buffer.alloc(2048, 0x52).toString("base64"),
        mediaFactCarrier: "media-store-url",
      }),
    );

    expect(saveMediaBuffer).toHaveBeenCalledOnce();
    expect(firstRunAssembledParams(runtime).ctxPayload.media).toMatchObject([
      { path: undefined, url: "media://inbound/stored-audio.ogg", contentType: "audio/ogg" },
    ]);
  });

  it("rejects non-http attachment URLs without dropping the message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await receiveAttachments(
      attachment({ url: "file:///etc/passwd" }),
      attachment({
        id: "attachment-2",
        kind: "file",
        mimeType: "text/plain",
        url: "data:text/plain;base64,SGVsbG8=",
      }),
    );

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    const ctxPayload = firstRunAssembledParams(runtime).ctxPayload;
    expect(ctxPayload.media?.every((fact) => fact.path === undefined)).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("uses allowFrom as the group sender fallback for allowlist policy", async () => {
    await handleQaInbound(
      createQaInboundParams({
        accountConfig: {
          allowFrom: ["alice"],
          groupPolicy: "allowlist",
        },
        message: {
          conversation: {
            kind: "group",
            id: "qa-room",
            title: "QA Room",
          },
        },
      }),
    );

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips configured group messages that miss mention activation", async () => {
    vi.mocked(runtime.channel.mentions.buildMentionRegexes).mockReturnValue([/\b@?openclaw\b/i]);
    await receive({
      accountConfig: { groups: { "qa-room": { requireMention: true } } },
      message: {
        conversation: { kind: "group", id: "qa-room" },
        text: "plain group message",
      },
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });
});

function attachment(overrides: Partial<Attachment>): Attachment {
  return { id: "attachment-1", kind: "image" as const, mimeType: "image/png", ...overrides };
}

function expectSend(nth: number, payload: Record<string, unknown>) {
  expect(sendQaBusMessage).toHaveBeenNthCalledWith(nth, expect.objectContaining(payload));
}

async function assembledTurn(runtime = createPluginRuntimeMock()) {
  setQaChannelRuntime(runtime);
  await startQaInbound(runtime);
  return firstRunAssembledParams(runtime);
}

describe("QA preview terminal ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not delete a promoted answer during later error cleanup", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    turn.delivery.onError?.(new Error("later dispatch failure"), { kind: "final" });
    // This queued callback drains the same lock after the cleanup callback.
    await turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("does not create a preview after a final without an earlier preview", async () => {
    const turn = await assembledTurn();
    await turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).not.toHaveBeenCalled();
  });

  it("retains distinct final chunks rather than dropping all later delivery", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    await turn.delivery.deliver({ text: "answer one" }, { kind: "final" });
    await turn.delivery.deliver({ text: "answer two" }, { kind: "final" });
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledTimes(2);
    expectSend(2, { text: "answer two" });
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("does not close previews for an empty nonterminal block", async () => {
    const turn = await assembledTurn();
    await turn.delivery.deliver({ text: "" }, { kind: "block" });
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("stops partials queued while the final edit is still in flight", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    vi.mocked(editQaBusMessage).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { message: { ...createQaInboundParams().message, direction: "outbound" } };
    });
    const final = turn.delivery.deliver({ text: "answer" }, { kind: "final" });
    await entered.promise;
    const late = turn.replyOptions?.onPartialReply?.({ text: "late draft" });
    release.resolve();
    await Promise.all([final, late]);
    expect(editQaBusMessage).toHaveBeenCalledOnce();
    expect(editQaBusMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "answer" }));
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
    expect(deleteQaBusMessage).not.toHaveBeenCalled();
  });

  it("keeps cleanup ownership when the final edit failed", async () => {
    const turn = await assembledTurn();
    await turn.replyOptions?.onPartialReply?.({ text: "draft" });
    vi.mocked(editQaBusMessage).mockRejectedValueOnce(new Error("final edit failed"));
    await expect(turn.delivery.deliver({ text: "answer" }, { kind: "final" })).rejects.toThrow(
      "final edit failed",
    );
    turn.delivery.onError?.(new Error("dispatch failed"), { kind: "final" });
    await turn.replyOptions?.onPartialReply?.({ text: "late" });
    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(sendQaBusMessage).toHaveBeenCalledOnce();
  });

  it("preserves the dispatch failure when preview cleanup also fails", async () => {
    const failure = new Error("dispatch failed");
    vi.mocked(deleteQaBusMessage).mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(
      runQaInbound(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(deleteQaBusMessage).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  });
});

it("admits symbolic group members from each supplied config snapshot", async () => {
  const runtime = createPluginRuntimeMock();
  setQaChannelRuntime(runtime);
  for (const members of [["alice"], ["bob"], ["alice"]]) {
    vi.mocked(runtime.channel.inbound.dispatch).mockClear();
    const params = createQaInboundParams({
      accountConfig: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:reviewers"],
      },
      message: { conversation: { kind: "group", id: "qa-room" } },
    });
    const config = {
      channels: {},
      accessGroups: {
        reviewers: { type: "message.senders", members: { "qa-channel": members } },
      },
    } satisfies OpenClawConfig;

    await handleQaInbound({ ...params, config });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(
      members.includes("alice") ? 1 : 0,
    );
  }
});
