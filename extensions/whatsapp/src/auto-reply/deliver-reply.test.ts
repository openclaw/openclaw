import type { WAMessage } from "baileys";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeWhatsAppSendResult } from "../inbound/send-result.js";
import { createAcceptedWhatsAppSendResult } from "../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { withWhatsAppSocketOperationTimeout } from "../socket-timing.js";
import { whatsappOutboundLog } from "./loggers.js";

const hoisted = vi.hoisted(() => ({
  recordChannelActivity: vi.fn(),
  transcodeAudioBufferToOpus: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-activity-runtime")>()),
  recordChannelActivity: (...args: unknown[]) => hoisted.recordChannelActivity(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  transcodeAudioBufferToOpus: hoisted.transcodeAudioBufferToOpus,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  shouldLogVerbose: vi.fn(() => true),
  logVerbose: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: vi.fn(),
}));

let deliverWebReply: typeof import("./deliver-reply.js").deliverWebReply;
let createWhatsAppReplyTransportContext: typeof import("./deliver-reply.js").createWhatsAppReplyTransportContext;

type DeliveryParams = Parameters<typeof deliverWebReply>[0];
type DeliveryOverrides = Partial<Omit<DeliveryParams, "replyResult" | "transport">>;
type LoadedWebMedia = Awaited<ReturnType<typeof loadWebMedia>>;
type LoadedMediaKind = LoadedWebMedia["kind"] | "file";

function makeMsg(): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    payload: { body: "latest batch body" },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "+20000000000",
      senderJid: "222@s.whatsapp.net",
      reply: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "reply-sent-1")),
      sendMedia: vi.fn(async () => createAcceptedWhatsAppSendResult("media", "media-sent-1")),
    },
    admission: {
      accountId: "work",
      conversation: { kind: "group", id: "+10000000000" },
      sender: { id: "222@s.whatsapp.net" },
      senderAccess: { reasonCode: "group_policy_allowed" },
    },
  });
}

function mockLoadedMedia(
  bytes: string,
  contentType: string | undefined,
  kind: LoadedMediaKind,
  fileName?: string,
) {
  vi.mocked(loadWebMedia).mockResolvedValueOnce({
    buffer: Buffer.from(bytes),
    contentType,
    kind,
    ...(fileName ? { fileName } : {}),
  } as LoadedWebMedia);
}

function replyText(msg: AdmittedWebInboundMessage, callIndex = 0): string {
  return vi.mocked(msg.platform.reply).mock.calls[callIndex]![0];
}

function expectQuotedOptions(
  options: Parameters<AdmittedWebInboundMessage["platform"]["reply"]>[1],
  expected: { id: string; fromMe: boolean; participant: string; body: string },
) {
  expect(options?.quoted?.key).toMatchObject({
    id: expected.id,
    fromMe: expected.fromMe,
    participant: expected.participant,
  });
  expect(options?.quoted?.message).toEqual({ conversation: expected.body });
}

function expectMedia(
  msg: AdmittedWebInboundMessage,
  payload: Record<string, unknown>,
  callIndex = 0,
) {
  const [actual, options] = vi.mocked(msg.platform.sendMedia).mock.calls[callIndex]!;
  expect(actual).toMatchObject(payload);
  return { actual, options };
}

function expectVoiceNote(msg: AdmittedWebInboundMessage, audio: unknown) {
  const { actual, options } = expectMedia(msg, {
    ptt: true,
    mimetype: "audio/ogg; codecs=opus",
  });
  expect(actual).toHaveProperty("audio", audio);
  expect(options).toBeUndefined();
  expect(actual).not.toHaveProperty("caption");
  expect(msg.platform.reply).toHaveBeenCalledWith("cap", undefined);
}

async function expectPartialDelivery(params: DeliveryParams, ids: string[], cause: Error) {
  const failure: unknown = await deliverWebReply(params).catch((caught: unknown) => caught);
  expect(isChannelPartialDeliveryError(failure)).toBe(true);
  if (!isChannelPartialDeliveryError(failure)) {
    throw new Error("accepted delivery receipt was not preserved");
  }
  expect(failure.deliveryResult.messageIds).toEqual(ids);
  expect(failure.deliveryResult.receipt?.platformMessageIds).toEqual(ids);
  expect(failure).toHaveProperty("cause", cause);
  return failure;
}

async function createSocketOperationTimeoutError(): Promise<unknown> {
  vi.useFakeTimers();
  try {
    const failurePromise = withWhatsAppSocketOperationTimeout(
      "sendMessage",
      new Promise<never>(() => {}),
      1_000,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    return await failurePromise;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function createDelivery(
  replyResult: DeliveryParams["replyResult"],
  overrides: DeliveryOverrides = {},
): { msg: AdmittedWebInboundMessage; params: DeliveryParams } {
  const msg = makeMsg();
  return {
    msg,
    params: {
      replyResult,
      transport: createWhatsAppReplyTransportContext(msg),
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      ...overrides,
    },
  };
}

function createImageDelivery(text: string, overrides: DeliveryOverrides = {}, replyToId?: string) {
  const delivery = createDelivery(
    { text, mediaUrl: "http://example.com/img.jpg", ...(replyToId ? { replyToId } : {}) },
    overrides,
  );
  mockLoadedMedia("img", "image/jpeg", "image");
  return delivery;
}

async function expectReplySuppressed(replyResult: { text: string; isReasoning?: boolean }) {
  const { msg, params } = createDelivery(replyResult);
  await deliverWebReply(params);
  expect(msg.platform.reply).not.toHaveBeenCalled();
  expect(msg.platform.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  beforeAll(async () => {
    ({ createWhatsAppReplyTransportContext, deliverWebReply } = await import("./deliver-reply.js"));
  });

  it.each([false, true])(
    "keeps delivered text and media captions out of diagnostics (media=%s)",
    async (hasMedia) => {
      const text = "private outbound WhatsApp message with confidential account details";
      const { msg, params } = hasMedia ? createImageDelivery(text) : createDelivery({ text });
      const logger = { info: vi.fn(), warn: vi.fn() };
      vi.mocked(logVerbose).mockClear();
      await deliverWebReply({ ...params, replyLogger: logger });

      if (hasMedia) {
        expectMedia(msg, { caption: text });
      } else {
        expect(replyText(msg)).toBe(text);
      }
      expect(logger.info).toHaveBeenCalled();
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(text);
      expect(JSON.stringify(vi.mocked(logVerbose).mock.calls)).not.toContain(text);
      if (hasMedia) {
        const source = "http://example.com/img.jpg";
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(source);
        expect(JSON.stringify(vi.mocked(logVerbose).mock.calls)).not.toContain(source);
      }
    },
  );

  it("does not resend an accepted reply when its transport reports a disconnect afterward", async () => {
    const { msg, params } = createDelivery({ text: "already delivered" });
    const disconnect = new Error("connection closed");
    const acceptedFailure = createChannelPartialDeliveryError(disconnect, {
      messageIds: ["reply-already-accepted"],
      visibleReplySent: true,
    });
    vi.mocked(msg.platform.reply).mockRejectedValue(acceptedFailure);

    const failure = await expectPartialDelivery(params, ["reply-already-accepted"], disconnect);
    expect(failure).not.toBe(acceptedFailure);
    expect(failure).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
    expect(msg.platform.reply).toHaveBeenCalledOnce();
  });

  it("suppresses payloads flagged as reasoning", async () => {
    await expectReplySuppressed({ text: "hidden", isReasoning: true });
  });

  it("suppresses payloads that start with a quoted reasoning prefix", async () => {
    await expectReplySuppressed({ text: " > Reasoning:\n> _hidden_" });
  });

  it("retains an accepted auto-reply receipt when outbound activity bookkeeping fails", async () => {
    hoisted.recordChannelActivity.mockClear();
    const activityError = new Error("auto-reply activity bookkeeping disconnected");
    hoisted.recordChannelActivity.mockImplementationOnce(() => {
      throw activityError;
    });
    const { msg, params } = createDelivery({ text: "already accepted" });

    await expectPartialDelivery(params, ["reply-sent-1"], activityError);
    expect(msg.platform.reply).toHaveBeenCalledOnce();
    expect(hoisted.recordChannelActivity).toHaveBeenCalledOnce();
  });

  it("merges earlier accepted chunks with a nested accepted-chunk bookkeeping failure", async () => {
    hoisted.recordChannelActivity.mockClear();
    const bookkeepingError = new Error("second accepted chunk bookkeeping failed");
    const firstChunk = normalizeWhatsAppSendResult(
      { key: { id: "auto-reply-first-chunk" } } as WAMessage,
      "text",
    );
    const secondChunk = normalizeWhatsAppSendResult(
      { key: { id: "auto-reply-second-chunk" } } as WAMessage,
      "text",
    );
    const { msg, params } = createDelivery({ text: "aaaaaa" }, { textLimit: 3 });
    vi.mocked(msg.platform.reply)
      .mockResolvedValueOnce(firstChunk)
      .mockRejectedValueOnce(
        createChannelPartialDeliveryError(bookkeepingError, {
          messageIds: [secondChunk.messageId],
          receipt: secondChunk.receipt,
          visibleReplySent: true,
        }),
      );

    await expectPartialDelivery(
      params,
      ["auto-reply-first-chunk", "auto-reply-second-chunk"],
      bookkeepingError,
    );
    expect(msg.platform.reply).toHaveBeenCalledTimes(2);
    expect(hoisted.recordChannelActivity).toHaveBeenCalledOnce();
  });

  it("rejects text replies that Baileys did not accept without recording outbound activity", async () => {
    hoisted.recordChannelActivity.mockClear();
    const { msg, params } = createDelivery({ text: "hello" });
    vi.mocked(msg.platform.reply).mockResolvedValueOnce({
      ...createAcceptedWhatsAppSendResult("text", "unknown"),
      receipt: undefined,
      keys: [],
      providerAccepted: false,
    });

    await expect(deliverWebReply(params)).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);

    expect(msg.platform.reply).toHaveBeenCalledOnce();
    expect(hoisted.recordChannelActivity).not.toHaveBeenCalled();
  });

  it("uses the same final sanitizer stack for auto-reply text delivery", async () => {
    const { msg, params } = createDelivery(
      {
        text: 'Before\n<function_calls>\n  <invoke name="send_message">\n    <parameter name="text"><b>hidden</b></parameter>\n  </invoke>\n</function_calls>\n<div>After</div>',
      },
      { textLimit: 4000 },
    );

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toBe("Before\n\nAfter\n");
  });

  it("does not retry terminal socket operation timeouts", async () => {
    const { msg, params } = createDelivery({ text: "hi" });
    const timeout = await createSocketOperationTimeoutError();
    vi.mocked(msg.platform.reply).mockRejectedValueOnce(timeout);

    await expect(deliverWebReply(params)).rejects.toBe(timeout);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
  });

  it("marks errors visible after accepted media delivery", async () => {
    const { msg, params } = createImageDelivery("captiontail", { textLimit: 7 });
    const error = new Error("tail send failed");
    vi.mocked(msg.platform.reply).mockRejectedValue(error);

    await expect(deliverWebReply(params)).rejects.toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
    });

    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalled();
  });

  it("preserves leading indentation after trimming only leading blank lines", async () => {
    const { msg, params } = createDelivery({ text: "\n \n    indented block" });

    await deliverWebReply(params);

    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(msg.platform.reply).toHaveBeenCalledWith("    indented block", undefined);
  });

  it("keeps quote threading on media and trailing text chunks for a threaded reply", async () => {
    const { msg, params } = createImageDelivery("captiontrail", { textLimit: 7 }, "reply-2");
    cacheInboundMessageMeta("work", "15551234567@s.whatsapp.net", "reply-2", {
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
      fromMe: true,
    });

    await deliverWebReply(params);

    const { options } = expectMedia(msg, {
      image: expect.any(Buffer),
      caption: "caption",
      mimetype: "image/jpeg",
    });
    const quote = {
      id: "reply-2",
      fromMe: true,
      participant: "111@s.whatsapp.net",
      body: "quoted media body",
    };
    expectQuotedOptions(options, quote);
    expect(replyText(msg)).toBe("trail");
    expectQuotedOptions(vi.mocked(msg.platform.reply).mock.calls[0]![1], quote);
  });

  it("still attempts later media after the first media fails", async () => {
    vi.clearAllMocks();
    const { msg, params } = createDelivery({
      text: "caption",
      mediaUrls: ["http://example.com/bad.jpg", "http://example.com/good.pdf"],
    });
    mockLoadedMedia("bad", "image/jpeg", "image");
    mockLoadedMedia("good", "application/pdf", "file", "good.pdf");
    const errorDetail = "upload failed for http://example.com/bad.jpg";
    vi.mocked(msg.platform.sendMedia).mockRejectedValueOnce(new Error(errorDetail));
    vi.mocked(msg.platform.sendMedia).mockResolvedValueOnce(
      createAcceptedWhatsAppSendResult("media", "media-second-1"),
    );

    const outboundError = vi.spyOn(whatsappOutboundLog, "error").mockImplementation(() => {});
    try {
      await deliverWebReply(params);
      expect(outboundError).toHaveBeenCalled();
      expect(JSON.stringify(outboundError.mock.calls)).not.toContain(errorDetail);
      expect(replyLogger.warn).toHaveBeenCalledWith(
        { to: "+10000000000" },
        "failed to send web media reply",
      );
      expect(JSON.stringify(replyLogger.warn.mock.calls)).not.toContain(errorDetail);
    } finally {
      outboundError.mockRestore();
    }

    expect(loadWebMedia).toHaveBeenNthCalledWith(1, "http://example.com/bad.jpg", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(loadWebMedia).toHaveBeenNthCalledWith(2, "http://example.com/good.pdf", {
      maxBytes: 1024 * 1024,
      localRoots: undefined,
    });
    expect(msg.platform.sendMedia).toHaveBeenCalledTimes(2);
    const { actual, options } = expectMedia(
      msg,
      {
        document: expect.any(Buffer),
        fileName: "good.pdf",
        mimetype: "application/pdf",
      },
      1,
    );
    expect(actual).toHaveProperty("caption", undefined);
    expect(options).toBeUndefined();
    expect(msg.platform.reply).toHaveBeenCalledTimes(1);
    expect(replyText(msg)).toContain("⚠️ Media failed");
    expect(replyText(msg)).not.toContain(errorDetail);
  });

  it("sends audio media as ptt voice note with visible text separately", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/a.ogg",
    });
    mockLoadedMedia("aud", "audio/ogg", "audio");

    await deliverWebReply(params);

    expectVoiceNote(msg, expect.any(Buffer));
  });

  it("transcodes mp3 audio media before sending a ptt voice note", async () => {
    vi.clearAllMocks();
    hoisted.transcodeAudioBufferToOpus.mockResolvedValue(Buffer.from("opus-output"));
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "http://example.com/a.mp3",
    });
    mockLoadedMedia("mp3", "audio/mpeg", "audio", "voice.mp3");

    await deliverWebReply(params);

    expect(hoisted.transcodeAudioBufferToOpus).toHaveBeenCalledWith({
      audioBuffer: Buffer.from("mp3"),
      inputFileName: "voice.mp3",
      tempPrefix: "whatsapp-voice-",
      outputFileName: "voice.ogg",
      maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
      sampleRateHz: 48000,
      channels: 1,
      bitrate: "64k",
    });
    expectVoiceNote(msg, Buffer.from("opus-output"));
  });

  it("strips URL query and fragment data from derived document file names", async () => {
    const { msg, params } = createDelivery({
      text: "cap",
      mediaUrl: "https://example.com/report.pdf?X-Amz-Signature=secret#frag",
    });
    mockLoadedMedia("pdf", "application/pdf", "file");

    await deliverWebReply(params);

    const { options } = expectMedia(msg, {
      document: expect.any(Buffer),
      fileName: "report.pdf",
      caption: "cap",
      mimetype: "application/pdf",
    });
    expect(options).toBeUndefined();
  });
});
