import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
// Matrix tests cover send plugin behavior.
import type * as TableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import type * as ChunkRuntime from "openclaw/plugin-sdk/reply-chunking";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { getMatrixRuntime, setMatrixRuntime } from "../runtime.js";
import { installMatrixTestRuntime, resetMatrixTestStores } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import { voteMatrixPoll } from "./actions/polls.js";
import {
  loadMatrixDeliveryPlan,
  reconcileMatrixUnknownSend,
  resolveMatrixDurableDeliveryIdentity,
} from "./delivery-plan.js";
import { createMatrixDraftStream } from "./draft-stream.js";
import { markdownToMatrixBody, markdownToMatrixHtml } from "./format.js";
import { createBundledReplacementEvent } from "./monitor/test-events.js";
import { matrixEventToRaw } from "./sdk/event-helpers.js";
import {
  chunkMatrixText,
  editMessageMatrix,
  sendMessageMatrix,
  sendPollMatrix,
  sendSingleTextMessageMatrix,
  sendTypingMatrix,
} from "./send.js";
import {
  createEncryptedMediaPayload,
  makeClient,
  makeEncryptedMediaClient,
} from "./send.test-support.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.fn(() => ({}));
const withResolvedRuntimeMatrixClientMock = vi.hoisted(() => vi.fn());
const getImageMetadataMock = vi.fn().mockResolvedValue(null);
const resizeToJpegMock = vi.fn();
const mediaKindFromMimeMock = vi.fn((_mime: string | null | undefined) => "image");
const isVoiceCompatibleAudioMock = vi.fn(
  (_options: { contentType?: string | null; fileName?: string | null }) => false,
);
const { resolveTextChunkLimitMock, resolveMarkdownTableModeMock } = vi.hoisted(() => ({
  resolveTextChunkLimitMock: vi.fn<typeof ChunkRuntime.resolveTextChunkLimit>(() => 4000),
  resolveMarkdownTableModeMock: vi.fn<typeof TableRuntime.resolveMarkdownTableMode>(() => "code"),
}));
const chunkMarkdownTextWithModeMock = vi.fn<
  (text: string, limit?: number, mode?: unknown) => string[]
>((text) => (text ? [text] : []));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: resolveMarkdownTableModeMock,
}));

vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  resolveTextChunkLimit: resolveTextChunkLimitMock,
}));

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

vi.mock("./client-bootstrap.js", () => ({
  withResolvedRuntimeMatrixClient: withResolvedRuntimeMatrixClientMock,
}));

const runtimeStub = {
  config: {
    current: () => loadConfigMock(),
  },
  media: {
    mediaKindFromMime: (mime?: string | null) => mediaKindFromMimeMock(mime),
    isVoiceCompatibleAudio: (opts: { contentType?: string | null; fileName?: string | null }) =>
      isVoiceCompatibleAudioMock(opts),
    getImageMetadata: (...args: unknown[]) => getImageMetadataMock(...args),
    resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
  },
  channel: {
    text: {
      resolveTextChunkLimit: resolveTextChunkLimitMock,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string, limit: number, mode: unknown) =>
        chunkMarkdownTextWithModeMock(text, limit, mode),
      resolveMarkdownTableMode: resolveMarkdownTableModeMock,
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

const requireRecord = createRequireRecord("object", "expected-label");

function createMatrixTestDecryptionFailure(event: MatrixEvent) {
  const failed = new MatrixEvent({
    ...event.event,
    type: "m.room.message",
    content: {
      msgtype: "m.bad.encrypted",
      body: "Synthetic missing session key",
      "m.relates_to": event.getWireContent()["m.relates_to"],
    },
  });
  vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
  return failed;
}

function mockCallArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  label: string,
  argIndex: number,
) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[argIndex];
}

function sentContent(index = 0) {
  return requireRecord(sendMessage.mock.calls[index]?.[1], `sent content ${index}`);
}

function newContent(content: Record<string, unknown>) {
  return requireRecord(content["m.new_content"], "new content");
}

function splitTextAtLimit(text: string, limit = text.length): string[] {
  return Array.from({ length: Math.ceil(text.length / limit) }, (_, index) =>
    text.slice(index * limit, (index + 1) * limit),
  );
}

function resetMatrixSendRuntimeMocks() {
  setMatrixRuntime(runtimeStub);
  loadOutboundMediaFromUrlMock.mockReset().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  });
  loadConfigMock.mockReset().mockReturnValue({});
  withResolvedRuntimeMatrixClientMock
    .mockReset()
    .mockImplementation(
      async (
        opts: { client?: import("./sdk.js").MatrixClient },
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<unknown>,
      ) => {
        if (!opts.client) {
          throw new Error("test Matrix client is required");
        }
        return await run(opts.client);
      },
    );
  getImageMetadataMock.mockReset().mockResolvedValue(null);
  resizeToJpegMock.mockReset();
  mediaKindFromMimeMock.mockReset().mockReturnValue("image");
  isVoiceCompatibleAudioMock.mockReset().mockReturnValue(false);
  resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
  resolveMarkdownTableModeMock.mockReset().mockReturnValue("code");
  chunkMarkdownTextWithModeMock
    .mockReset()
    .mockImplementation((text: string) => (text ? [text] : []));
}

let { client, sendMessage, sendEvent, getEvent, getRelations, uploadContent } = makeClient();
beforeEach(() => {
  vi.clearAllMocks();
  resetMatrixSendRuntimeMocks();
  ({ client, sendMessage, sendEvent, getEvent, getRelations, uploadContent } = makeClient());
});

function send(text: string, opts: Partial<Parameters<typeof sendMessageMatrix>[2]> = {}) {
  return sendMessageMatrix("room:!room:example", text, { client, cfg: {}, ...opts });
}

function edit(text: string, opts: Partial<Parameters<typeof editMessageMatrix>[3]> = {}) {
  return editMessageMatrix("room:!room:example", "$original", text, { client, cfg: {}, ...opts });
}

function mockDurableSend(accept: (transactionId: string) => string) {
  sendMessage.mockImplementation(async (...args: Parameters<typeof client.sendMessage>) => {
    const [roomId, , transactionId, beforeWireDispatch] = args;
    if (!transactionId || !beforeWireDispatch) {
      throw new Error("expected durable Matrix dispatch context");
    }
    await beforeWireDispatch({
      roomId,
      eventType: "m.room.message",
      transactionId,
      requestPath: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
    });
    return accept(transactionId);
  });
}

function chunksFor(text: string, limit: number) {
  resolveTextChunkLimitMock.mockReturnValue(limit);
  chunkMarkdownTextWithModeMock.mockImplementation(splitTextAtLimit);
  return chunkMatrixText(text, { cfg: {}, tableMode: "block" }).chunks;
}

describe("Matrix formatted chunk boundaries", () => {
  it("closes and reopens spoilers without exposing chunked secret text", () => {
    const secret = "secret ".repeat(8).trim();
    const chunks = chunksFor(`before ||${secret}|| after`, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    for (const chunk of chunks) {
      expect(markdownToMatrixBody(chunk)).not.toContain("secret");
      expect(markdownToMatrixHtml(chunk)).not.toContain("||");
    }
  });

  it("does not pair an unmatched paragraph delimiter with a later spoiler", () => {
    const secret = "secret ".repeat(8).trim();
    const chunks = chunksFor(`first ||\n\nsecond ||${secret}||`, 20);

    expect(chunks.join("")).toContain("[Spoiler]");
    expect(chunks.every((chunk) => !markdownToMatrixBody(chunk).includes("secret"))).toBe(true);
  });

  it("keeps underline-looking tags in code and link metadata literal", () => {
    const markdown = `\`<ins>\` \\<u> [x](https://example.test "literal <u>") ${"plain ".repeat(8)}`;
    const chunks = chunksFor(markdown, 20);

    expect(chunks.join("")).toBe(markdown.trim());
    expect(chunks.join("")).not.toContain("</u>");
  });

  it("keeps spoiler and underline nesting valid across chunks", () => {
    const markdown = `||<u><ins>nested</ins> ${"nested ".repeat(8).trim()}</u>||`;
    const chunks = chunksFor(markdown, 24);

    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(
      chunks.every((chunk) => {
        const html = markdownToMatrixHtml(chunk);
        return html.includes("<span data-mx-spoiler>") && html.includes("<u>");
      }),
    ).toBe(true);
  });

  it("preserves indentation after a native table segment", () => {
    const table = "| A | B |\n|---|---|\n| 1 | 2 |";
    const code = "    indented code";
    const chunks = chunksFor(`${"prose ".repeat(10)}\n\n${table}\n\n${code}`, 40);

    expect(chunks).toContain(code);
    expect(chunks).toContain(table);
    expect(markdownToMatrixHtml(table, { tableMode: "block" })).toContain("<table>");
  });

  it("recognizes aligned tables and ignores table examples inside fences", () => {
    const aligned = "| A | B |\n| ---: | :---: |\n| 1 | 2 |\n| 3 | 4 |";
    expect(chunksFor(aligned, 35).join("\n")).toContain("• B:");

    const fenced = `\`\`\`\n${aligned}\n\`\`\``;
    expect(chunksFor(fenced, 35).join("")).toBe(fenced);

    const shortDivider = "A|B\n-| -\nbar";
    expect(chunksFor(shortDivider, 8).join("\n")).toContain("**bar**");
  });
});

describe("sendMessageMatrix durable delivery", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-send-plan-"));
    installMatrixTestRuntime({
      stateDir,
      cfg: {},
      channel: runtimeStub.channel,
    });
    setMatrixRuntime({ ...getMatrixRuntime(), media: runtimeStub.media });
  });

  afterEach(async () => {
    await resetMatrixTestStores();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("dispatches fractional BMP and astral limits through the real send path", async () => {
    chunkMarkdownTextWithModeMock.mockImplementation((text) => Array.from(text));
    for (const [limit, text, bodies] of [
      [0.5, "ABCD", ["A", "B", "C", "D"]],
      [1.5, "😀😀", ["😀", "😀"]],
      [1.5, "😀AB", ["😀", "A", "B"]],
      [1, "😀AB", ["😀", "A", "B"]],
    ] as const) {
      const fixture = makeClient();
      resolveTextChunkLimitMock.mockReturnValue(limit);
      await send(text, { client: fixture.client });
      expect(fixture.sendMessage).toHaveBeenCalledTimes(bodies.length);
      expect(
        fixture.sendMessage.mock.calls.map((call) => requireRecord(call[1], "content").body),
      ).toEqual(bodies);
    }
  });

  it("persists the complete event plan before the first provider dispatch", async () => {
    const deliveryIdentity = resolveMatrixDurableDeliveryIdentity({
      queueId: "queue-1",
      partIndex: 0,
      partCount: 1,
    });
    if (!deliveryIdentity) {
      throw new Error("expected durable Matrix identity");
    }
    const dispatch = vi.fn(async () => {
      await expect(
        loadMatrixDeliveryPlan({
          identity: deliveryIdentity,
          accountId: "default",
          roomId: "!room:example",
          transactionScopeId: "scope-1",
          wireEventType: "m.room.message",
        }),
      ).resolves.not.toBeNull();
    });
    mockDurableSend(() => "$event-1");

    const result = await send("durable", {
      accountId: "default",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
      deliveryPartCount: 1,
      onPlatformSendDispatch: dispatch,
    });

    expect(result.messageId).toBe("$event-1");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[2]).toMatch(/^oc_/);
  });

  it("recovers actual media reply relations after losing the overflow response", async () => {
    resolveTextChunkLimitMock.mockReturnValue(6);
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    const acceptedTransactions = new Map<string, string>();
    mockDurableSend((transactionId) => {
      const existingId = acceptedTransactions.get(transactionId);
      if (existingId) {
        return existingId;
      }
      const eventId = acceptedTransactions.size === 0 ? "$image" : "$overflow";
      acceptedTransactions.set(transactionId, eventId);
      if (eventId === "$overflow") {
        throw new Error("provider response lost");
      }
      return eventId;
    });
    const payload = { text: "first|second", mediaUrl: "file:///tmp/photo.png" };
    const onDeliveryResult = vi.fn();
    await expect(
      send(payload.text, {
        accountId: "default",
        mediaUrl: payload.mediaUrl,
        onDeliveryResult,
        replyToId: "$reply",
        deliveryQueueId: "queue-media",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    ).rejects.toThrow("provider response lost");
    expect(
      onDeliveryResult.mock.calls.map(([result]) => [result.messageId, result.content]),
    ).toEqual([["$image", "first"]]);
    expect(sentContent(0)["m.relates_to"]).toEqual({
      "m.in_reply_to": { event_id: "$reply" },
    });
    expect(sentContent(1)).not.toHaveProperty("m.relates_to");
    withResolvedRuntimeMatrixClientMock.mockImplementationOnce(
      async (_opts: unknown, run: (resolved: typeof client) => Promise<unknown>) =>
        await run(client),
    );

    const recovered = await reconcileMatrixUnknownSend({
      cfg: {},
      queueId: "queue-media",
      channel: "matrix",
      to: "room:!room:example",
      accountId: "default",
      enqueuedAt: 1,
      payloads: [payload],
      retryCount: 0,
      effectiveReplyToId: "$reply",
    });

    expect(recovered.status).toBe("sent");
    if (recovered.status !== "sent") {
      throw new Error("expected recovered Matrix delivery");
    }
    expect(uploadContent).toHaveBeenCalledOnce();
    expect(acceptedTransactions.size).toBe(2);
    expect(sendMessage.mock.calls.slice(2).map((call) => call.slice(0, 3))).toEqual(
      sendMessage.mock.calls.slice(0, 2).map((call) => call.slice(0, 3)),
    );
    expect(recovered.messageId).toBe("$overflow");
    expect(recovered.receipt).toMatchObject({
      primaryPlatformMessageId: "$image",
      platformMessageIds: ["$image", "$overflow"],
      parts: [
        { platformMessageId: "$image", kind: "media", index: 0, replyToId: "$reply" },
        { platformMessageId: "$overflow", kind: "text", index: 1 },
      ],
    });
    expect(recovered.receipt?.parts[1]).not.toHaveProperty("replyToId");
  });
});

describe("sendMessageMatrix media", () => {
  it("rejects encrypted media before loading or reporting dispatch when encryption is disabled", async () => {
    vi.spyOn(client, "getMessageWireEventType").mockResolvedValue("m.room.encrypted");
    const onPlatformSendDispatch = vi.fn();
    await expect(
      send("secret", { mediaUrl: "file:///tmp/photo.png", onPlatformSendDispatch }),
    ).rejects.toThrow(/enable encryption/i);
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrlMock).not.toHaveBeenCalled();
    expect(uploadContent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("rechecks encryption after media loading (crypto=%s)", async (crypto) => {
    if (crypto) {
      ({ client, sendMessage, uploadContent } = makeEncryptedMediaClient());
      vi.spyOn(client, "getMessageWireEventType").mockResolvedValue("m.room.message");
    }
    loadOutboundMediaFromUrlMock.mockImplementationOnce(async () => {
      vi.spyOn(client, "getMessageWireEventType").mockResolvedValue("m.room.encrypted");
      return {
        buffer: Buffer.from("secret media"),
        fileName: "secret.png",
        contentType: "image/png",
        kind: "image",
      };
    });
    const onPlatformSendDispatch = vi.fn();
    const sending = send("secret", { mediaUrl: "file:///tmp/secret.png", onPlatformSendDispatch });
    if (crypto) {
      await sending;
      expect(uploadContent).toHaveBeenCalledWith(
        Buffer.from("encrypted"),
        "application/octet-stream",
      );
      expect(sentContent().file).toBeDefined();
      expect(sentContent().url).toBeUndefined();
    } else {
      await expect(sending).rejects.toThrow(/enable encryption/i);
      expect(uploadContent).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "uses the correct image and thumbnail payload (encrypted=%s)",
    async (encrypted) => {
      if (encrypted) {
        ({ client, sendMessage, uploadContent } = makeEncryptedMediaClient());
      }
      getImageMetadataMock
        .mockResolvedValueOnce({ width: 1600, height: 1200 })
        .mockResolvedValueOnce({ width: 800, height: 600 });
      resizeToJpegMock.mockResolvedValueOnce(Buffer.from("thumb"));
      uploadContent
        .mockResolvedValueOnce("mxc://example/main")
        .mockResolvedValueOnce("mxc://example/thumb");
      const mediaAccess = { localRoots: ["/tmp/openclaw"], workspaceDir: "/tmp/openclaw" };
      await send("    caption @room", {
        cfg: { channels: { matrix: { mediaMaxMb: 0 } } },
        mediaUrl: "chart.png",
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
      });
      expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith(
        "chart.png",
        expect.objectContaining({ mediaAccess, mediaLocalRoots: mediaAccess.localRoots }),
      );
      const content = sentContent();
      const info = requireRecord(content.info, "image info");
      expect(content).toMatchObject({
        msgtype: "m.image",
        filename: "photo.png",
        format: "org.matrix.custom.html",
        body: "    caption @room",
        formatted_body: "<pre><code>caption @room\n</code></pre>",
      });
      expect(content["m.mentions"]).toEqual({});
      expect(loadOutboundMediaFromUrlMock.mock.calls[0]?.[1].maxBytes).toBeUndefined();
      expect(info.mimetype).toBe("image/png");
      expect(info.thumbnail_info).toEqual({ w: 800, h: 600, mimetype: "image/jpeg", size: 5 });
      if (encrypted) {
        expect(client.crypto?.encryptMedia).toHaveBeenCalledTimes(2);
        expect(uploadContent.mock.calls).toEqual([
          [Buffer.from("encrypted"), "application/octet-stream"],
          [Buffer.from("encrypted"), "application/octet-stream"],
        ]);
        expect(content.url).toBeUndefined();
        expect(content.file).toMatchObject({ url: "mxc://example/main" });
        expect(info.thumbnail_url).toBeUndefined();
        expect(info.thumbnail_file).toMatchObject({ url: "mxc://example/thumb" });
      } else {
        expect(uploadContent.mock.calls).toEqual([
          [Buffer.from("media"), "image/png", "photo.png"],
          [Buffer.from("thumb"), "image/jpeg", "thumbnail.jpg"],
        ]);
        expect(content.url).toBe("mxc://example/main");
        expect(info.thumbnail_url).toBe("mxc://example/thumb");
        expect(info.thumbnail_file).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "preserves audio delivery and voice transcript relations (compatible=%s)",
    async (compatible) => {
      mediaKindFromMimeMock.mockReturnValue("audio");
      isVoiceCompatibleAudioMock.mockReturnValue(compatible);
      const fileName = compatible ? "clip.mp3" : "clip.wav";
      loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
        buffer: Buffer.from("audio"),
        fileName,
        contentType: compatible ? "audio/mpeg" : "audio/wav",
        kind: "audio",
      });
      sendMessage.mockReset().mockResolvedValueOnce("$voice").mockResolvedValueOnce("$transcript");
      const result = await send("voice caption", {
        mediaUrl: `file:///tmp/${fileName}`,
        audioAsVoice: true,
        replyToId: compatible ? "$reply" : undefined,
      });
      if (compatible) {
        expect(sentContent(1).body).toBe("voice caption");
        expect(sentContent(1)["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$reply" } });
        expect(result.receipt.parts).toMatchObject([
          { platformMessageId: "$voice", kind: "voice", index: 0, replyToId: "$reply" },
          { platformMessageId: "$transcript", kind: "text", index: 1, replyToId: "$reply" },
        ]);
      } else {
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sentContent()).toMatchObject({ msgtype: "m.audio", body: "voice caption" });
        expect(sentContent()["org.matrix.msc3245.voice"]).toBeUndefined();
      }
    },
  );

  it("rejects mixed attachments when a room becomes encrypted while an image is resized", async () => {
    const onPlatformSendDispatch = vi.fn();
    (client as { crypto?: object }).crypto = {
      encryptMedia: vi.fn().mockResolvedValue(createEncryptedMediaPayload()),
    };
    getImageMetadataMock
      .mockResolvedValueOnce({ width: 1600, height: 1200 })
      .mockResolvedValueOnce({ width: 800, height: 600 });
    resizeToJpegMock.mockImplementationOnce(async () => {
      vi.spyOn(client, "getMessageWireEventType").mockResolvedValue("m.room.encrypted");
      return Buffer.from("secret thumbnail");
    });

    await expect(
      send("caption", { mediaUrl: "file:///tmp/photo.png", onPlatformSendDispatch }),
    ).rejects.toThrow(/unencrypted media.*retry/i);

    expect(uploadContent.mock.calls).toEqual([
      [Buffer.from("media"), "image/png", "photo.png"],
      [Buffer.from("encrypted"), "application/octet-stream"],
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onPlatformSendDispatch).not.toHaveBeenCalled();
  });

  it("uses explicit cfg for media sends instead of runtime loadConfig fallbacks", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              mediaMaxMb: 1,
            },
          },
        },
      },
    };

    loadConfigMock.mockImplementation(() => {
      throw new Error("sendMessageMatrix should not reload runtime config when cfg is provided");
    });

    await send("caption", {
      cfg: explicitCfg,
      accountId: "ops",
      mediaUrl: "file:///tmp/photo.png",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(mockCallArg(loadOutboundMediaFromUrlMock, "loadOutboundMediaFromUrl", 0)).toBe(
      "file:///tmp/photo.png",
    );
    const mediaOptions = requireRecord(
      mockCallArg(loadOutboundMediaFromUrlMock, "loadOutboundMediaFromUrl", 1),
      "media options",
    );
    expect(mediaOptions.maxBytes).toBe(1024 * 1024);
    expect(mediaOptions.mediaLocalRoots).toBeUndefined();
    expect(resolveTextChunkLimitMock).toHaveBeenCalledWith(explicitCfg, "matrix", "ops");
  });
});

describe("sendMessageMatrix mentions", () => {
  it("does not emit mentions from fallback filenames when there is no caption", async () => {
    loadOutboundMediaFromUrlMock.mockResolvedValue({
      buffer: Buffer.from("media"),
      fileName: "@room.png",
      contentType: "image/png",
      kind: "image",
    });

    await send("", { mediaUrl: "file:///tmp/room.png" });

    expect(sentContent().body).toBe("@room.png");
    expect(sentContent()["m.mentions"]).toEqual({});
    expect(sentContent().formatted_body).toBeUndefined();
  });
});

describe("sendMessageMatrix threads", () => {
  it("preserves an explicit reply target inside its thread", async () => {
    await send("hello thread", { threadId: "$thread", replyToId: "$reply" });

    const content = sentContent();

    expect(content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$thread",
      "m.in_reply_to": { event_id: "$reply" },
    });
  });

  it("returns ordered receipts with extra content only on the first chunk", async () => {
    sendMessage
      .mockReset()
      .mockResolvedValueOnce("$m1")
      .mockResolvedValueOnce("$m2")
      .mockResolvedValueOnce("$m3");
    resolveTextChunkLimitMock.mockReturnValue(6);
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    const result = await send("first|second|third", {
      extraContent: { "com.openclaw.approval": { id: "req-1" } },
    });

    expect(result).toMatchObject({
      roomId: "!room:example",
      primaryMessageId: "$m1",
      messageId: "$m3",
      content: "first\nsecond\nthird",
      receipt: {
        primaryPlatformMessageId: "$m1",
        platformMessageIds: ["$m1", "$m2", "$m3"],
        parts: [
          { platformMessageId: "$m1", kind: "text" },
          { platformMessageId: "$m2", kind: "text" },
          { platformMessageId: "$m3", kind: "text" },
        ],
      },
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sentContent(0).body).toBe("first");
    expect(sentContent(0)["com.openclaw.approval"]).toEqual({ id: "req-1" });
    expect(sentContent(1).body).toBe("second");
    expect(sentContent(1)).not.toHaveProperty("com.openclaw.approval");
    expect(sentContent(2).body).toBe("third");
    expect(sentContent(2)).not.toHaveProperty("com.openclaw.approval");
  });
});

describe("sendSingleTextMessageMatrix", () => {
  it("rejects single-event sends when rendered text exceeds the Matrix limit", async () => {
    resolveTextChunkLimitMock.mockReturnValue(5);

    await expect(
      sendSingleTextMessageMatrix("room:!room:example", "123456", {
        client,
        cfg: {},
      }),
    ).rejects.toThrow("Matrix single-message text exceeds limit");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("supports retained partial draft sends and edits without a Matrix runtime", async () => {
    const [tableRuntime, chunkRuntime] = await Promise.all([
      vi.importActual<typeof TableRuntime>("openclaw/plugin-sdk/markdown-table-runtime"),
      vi.importActual<typeof ChunkRuntime>("openclaw/plugin-sdk/reply-chunking"),
    ]);
    resolveMarkdownTableModeMock.mockImplementation(tableRuntime.resolveMarkdownTableMode);
    resolveTextChunkLimitMock.mockImplementation(chunkRuntime.resolveTextChunkLimit);
    const cfg: CoreConfig = {
      channels: {
        matrix: {
          textChunkLimit: 8,
          accounts: { retained: { textChunkLimit: 256 } },
        },
      },
    };
    const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "matrix",
      errorMessage: "Matrix runtime not initialized",
    });
    const previousRuntime = getMatrixRuntime();
    vi.useFakeTimers();
    const stream = createMatrixDraftStream({
      roomId: "!room:example",
      threadId: "$thread",
      client,
      cfg,
      accountId: "retained",
    });
    try {
      runtimeStore.clearRuntime();
      expect(() => getMatrixRuntime()).toThrow("Matrix runtime not initialized");
      getEvent.mockResolvedValue({
        content: { "m.relates_to": { rel_type: "m.thread", event_id: "$thread" } },
      });
      stream.update(
        "Working...\n- `read matrix-progress-@room-@alice:example.org-!room:example.org.txt failed`",
      );
      await stream.flush();

      const content = sentContent();
      expect(content.msgtype).toBe("m.text");
      expect(content).not.toHaveProperty("m.mentions");
      expect(content["org.matrix.msc4357.live"]).toEqual({});
      expect(content.formatted_body).toContain(
        "<code>read matrix-progress-@room-@alice:example.org-!room:example.org.txt failed</code>",
      );
      expect(content.formatted_body).not.toContain("matrix.to");
      expect(content["m.relates_to"]).toMatchObject({ rel_type: "m.thread", event_id: "$thread" });

      const editedText = "Still working in the retained account";
      stream.update(editedText);
      await stream.flush();
      expect(sendMessage.mock.calls.map(([roomId]) => roomId)).toEqual([
        "!room:example",
        "!room:example",
      ]);
      expect(newContent(sentContent(1)).body).toBe(editedText);
      expect(sentContent(1)["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "evt1" });
      expect(newContent(sentContent(1))).not.toHaveProperty("m.relates_to");

      stream.update("x".repeat(257));
      await stream.flush();
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(stream.mustDeliverFinalNormally()).toBe(true);
    } finally {
      try {
        await stream.discardPending();
      } finally {
        runtimeStore.setRuntime(previousRuntime);
        vi.useRealTimers();
      }
    }
  });
});

describe("editMessageMatrix mentions", () => {
  it("notifies only new mentions across successive edits", async () => {
    const original = createBundledReplacementEvent("$original", {
      content: { body: "Hello @alice:example.org", "m.mentions": {} },
    });
    delete original.unsigned;
    getEvent.mockImplementation(async () => ({
      ...original,
      unsigned: undefined,
    }));
    getRelations.mockImplementation(async () => ({
      events: original.unsigned?.["m.relations"]?.["m.replace"]
        ? [original.unsigned["m.relations"]["m.replace"]]
        : [],
      nextBatch: null,
    }));
    const alice = { user_ids: ["@alice:example.org"] };
    const everyone = { room: true, user_ids: ["@alice:example.org", "@bob:example.org"] };
    const revisions = [
      { text: "Hello @alice:example.org", mentions: alice, notify: alice },
      { text: "Hello again @alice:example.org", mentions: alice, notify: {} },
      {
        text: "@room Hello @alice:example.org and @bob:example.org",
        mentions: everyone,
        notify: { room: true, user_ids: ["@bob:example.org"] },
      },
      {
        text: "@room Hello again @alice:example.org and @bob:example.org",
        mentions: everyone,
        notify: {},
      },
      { text: "Hello", mentions: {}, notify: {} },
      { text: "Hello @alice:example.org", mentions: alice, notify: alice },
    ];
    for (const [index, revision] of revisions.entries()) {
      await edit(revision.text);
      const content = sentContent(index);
      expect(content["m.mentions"], `revision ${index} notifications`).toEqual(revision.notify);
      expect(newContent(content)["m.mentions"]).toEqual(revision.mentions);
      original.unsigned = {
        "m.relations": {
          "m.replace": { ...original, unsigned: undefined, event_id: `$edit-${index}`, content },
        },
      };
    }
  });

  it("selects the latest valid edit across pages by timestamp and event ID", async () => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    getEvent.mockResolvedValue(original);
    const replacement = (eventId: string, timestamp: number, userIds: string[]) => ({
      ...original,
      event_id: eventId,
      origin_server_ts: timestamp,
      content: {
        "m.new_content": { body: "edited", "m.mentions": { user_ids: userIds } },
        "m.relates_to": { rel_type: "m.replace", event_id: original.event_id },
      },
    });
    const unreadable = (
      eventId: string,
      timestamp: number,
      relation = { rel_type: "m.replace", event_id: original.event_id },
    ) =>
      matrixEventToRaw(
        createMatrixTestDecryptionFailure(
          new MatrixEvent({
            sender: original.sender,
            event_id: eventId,
            origin_server_ts: timestamp,
            type: "m.room.encrypted",
            content: { "m.relates_to": relation },
          }),
        ),
      );
    getRelations
      .mockResolvedValueOnce({
        events: [replacement("$a", 300, ["@bob:example.org"])],
        nextBatch: "second",
      })
      .mockResolvedValueOnce({ events: [], nextBatch: "third" })
      .mockResolvedValueOnce({
        events: [
          unreadable("$older", 200),
          unreadable("$wrong-target", 500, { rel_type: "m.replace", event_id: "$other" }),
          unreadable("$wrong-relation", 500, { rel_type: "m.thread", event_id: "$original" }),
          {
            ...replacement("$redacted", 500, ["@bob:example.org"]),
            unsigned: { redacted_because: {} },
          },
          { ...replacement("$other", 500, ["@bob:example.org"]), sender: "@other:example.org" },
          { ...replacement("$wrong-type", 500, ["@bob:example.org"]), type: "m.room.notice" },
          replacement("$z", 300, ["@alice:example.org"]),
        ],
        nextBatch: null,
      });
    await edit("Hi @alice:example.org and @bob:example.org");
    expect(sentContent()["m.mentions"]).toEqual({ user_ids: ["@bob:example.org"] });
    expect(getRelations).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("rejects the latest unreadable edit (pending=%s)", async (pending) => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    getEvent.mockResolvedValue(original);
    let encrypted = new MatrixEvent({
      event_id: "$unreadable",
      sender: original.sender,
      origin_server_ts: 300,
      type: "m.room.encrypted",
      content: { "m.relates_to": { rel_type: "m.replace", event_id: original.event_id } },
    });
    if (!pending) {
      encrypted = createMatrixTestDecryptionFailure(encrypted);
    }
    getRelations.mockResolvedValue({ events: [matrixEventToRaw(encrypted)], nextBatch: null });
    await expect(edit("Hello @alice:example.org")).rejects.toThrow("not fully decrypted");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending"])("does not mutate a %s original", async (mode) => {
    const original = createBundledReplacementEvent("$original");
    delete original.unsigned;
    let encrypted = new MatrixEvent({
      event_id: original.event_id,
      sender: original.sender,
      origin_server_ts: original.origin_server_ts,
      content: original.content,
      type: "m.room.encrypted",
    });
    if (mode === "failed") {
      encrypted = createMatrixTestDecryptionFailure(encrypted);
    }
    getEvent.mockResolvedValue(matrixEventToRaw(encrypted));
    await expect(edit("Hello")).rejects.toThrow("not fully decrypted");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ignores wire decryptionFailure claims on original and bundled edits", async () => {
    const content = { body: "Hello Alice", "m.mentions": { user_ids: ["@alice:example.org"] } };
    const original = createBundledReplacementEvent("$original", {
      replacementContent: { "m.new_content": content },
    });
    requireRecord(
      original.unsigned?.["m.relations"]?.["m.replace"],
      "replacement",
    ).decryptionFailure = true;
    getEvent.mockResolvedValue({ ...original, decryptionFailure: true });
    await edit("Hello @alice:example.org");
    expect(sentContent()["m.mentions"]).toEqual({});
  });

  it("recovers legacy mentions from the original after a native overlay retires", async () => {
    const original = new MatrixEvent({
      event_id: "$original",
      sender: "@bot:example.org",
      type: "m.room.message",
      origin_server_ts: 1,
      content: { body: "Hello @alice:example.org" },
    });
    const overlay = createMatrixTestDecryptionFailure(
      new MatrixEvent({
        event_id: "$overlay",
        sender: "@bot:example.org",
        type: "m.room.encrypted",
        origin_server_ts: 2,
        content: { "m.relates_to": { rel_type: "m.replace", event_id: "$original" } },
      }),
    );
    original.makeReplaced(overlay);
    expect(original.isDecryptionFailure()).toBe(false);
    expect(original.getContent()).toEqual({});
    getEvent.mockResolvedValue(matrixEventToRaw(original));
    await edit("Hello @alice:example.org");
    expect(sentContent()["m.mentions"]).toEqual({});
  });

  it.each(["repeated", "unbounded"])(
    "does not send when relation pagination is %s",
    async (mode) => {
      const original = createBundledReplacementEvent("$original");
      delete original.unsigned;
      getEvent.mockResolvedValue(original);
      let page = 0;
      getRelations.mockImplementation(async () => ({
        events: [],
        nextBatch: mode === "repeated" ? "same" : String(++page),
      }));
      await expect(edit("Hi @alice:example.org")).rejects.toThrow(
        "history could not be fully read",
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(getRelations.mock.calls.length).toBeLessThanOrEqual(100);
    },
  );

  it("does not suppress mentions using a redacted original", async () => {
    getEvent.mockResolvedValue(
      createBundledReplacementEvent("$original", {
        redacted: true,
        content: {},
        replacementContent: {
          "m.new_content": {
            body: "Hi @bob:example.org",
            "m.mentions": { user_ids: ["@bob:example.org"] },
          },
        },
      }),
    );
    await edit("Hello @bob:example.org");
    expect(sentContent()["m.mentions"]).toEqual({ user_ids: ["@bob:example.org"] });
  });

  it("supports quiet draft preview edits without mention metadata or history reads", async () => {
    getEvent.mockRejectedValue(new Error("Matrix history unavailable"));

    await edit("@room hi @alice:example.org", { msgtype: "m.notice", includeMentions: false });

    expect(getEvent).not.toHaveBeenCalled();
    const content = sentContent();
    expect(content.msgtype).toBe("m.notice");
    expect(newContent(content).msgtype).toBe("m.notice");
    expect(content).not.toHaveProperty("m.mentions");
    expect(newContent(content)).not.toHaveProperty("m.mentions");
    expect(sentContent().formatted_body).not.toContain("matrix.to");
    expect(newContent(content).formatted_body).not.toContain("matrix.to");
  });

  it("rejects thread edits when the original event is not already in that thread", async () => {
    getEvent.mockResolvedValue({
      content: {
        body: "before",
        msgtype: "m.text",
      },
    });

    await expect(edit("done", { threadId: "$thread" })).rejects.toThrow(
      "cannot add or change the original event thread relation",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("sendPollMatrix mentions", () => {
  it("adds m.mentions for poll fallback text", async () => {
    await sendPollMatrix(
      "room:!room:example",
      { question: "@room lunch with @alice:example.org?", options: ["yes", "no"] },
      {
        client,
        cfg: {},
      },
    );

    expect(mockCallArg(sendEvent, "sendEvent", 0)).toBe("!room:example");
    expect(mockCallArg(sendEvent, "sendEvent", 1)).toBe("m.poll.start");
    const content = requireRecord(mockCallArg(sendEvent, "sendEvent", 2), "poll start content");
    expect(content["m.mentions"]).toEqual({ room: true, user_ids: ["@alice:example.org"] });
  });
});

describe("voteMatrixPoll", () => {
  it("maps 1-based option indexes to Matrix poll answer ids", async () => {
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
    });

    const result = await voteMatrixPoll("room:!room:example", "$poll", {
      client,
      cfg: {},
      optionIndex: 2,
    });

    expect(sendEvent).toHaveBeenCalledWith("!room:example", "m.poll.response", {
      "m.poll.response": { answers: ["a2"] },
      "org.matrix.msc3381.poll.response": { answers: ["a2"] },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
    expect(result.eventId).toBe("evt-poll-vote");
    expect(result.roomId).toBe("!room:example");
    expect(result.pollId).toBe("$poll");
    expect(result.answerIds).toEqual(["a2"]);
    expect(result.labels).toEqual(["Sushi"]);
  });
});

describe("sendTypingMatrix", () => {
  it("passes account config through when resolving the typing client", async () => {
    const cfg = { channels: { matrix: {} } } as unknown as import("../types.js").CoreConfig;
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const typingClient = { setTyping } as unknown as import("./sdk.js").MatrixClient;
    withResolvedRuntimeMatrixClientMock.mockImplementation(
      async (
        opts: Record<string, unknown>,
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<void>,
      ) => {
        expect(opts.cfg).toBe(cfg);
        expect(opts.accountId).toBe("work");
        expect(opts.timeoutMs).toBe(12_345);
        expect(opts.readiness).toBe("none");
        return await run(typingClient);
      },
    );

    await sendTypingMatrix("room:!room:example", true, {
      cfg,
      accountId: "work",
      timeoutMs: 12_345,
    });

    expect(setTyping).toHaveBeenCalledWith("!room:example", true, 12_345);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
