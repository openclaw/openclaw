import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../runtime.js";
import { createMatrixBotSdkMock } from "../test-mocks.js";

const resolveMatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("music-metadata", () => ({
  // `resolveMediaDurationMs` lazily imports `music-metadata`; in tests we don't
  // need real duration parsing and the real module is expensive to load.
  parseBuffer: vi.fn().mockResolvedValue({ format: {} }),
}));

vi.mock("@vector-im/matrix-bot-sdk", () =>
  createMatrixBotSdkMock({
    matrixClient: vi.fn(),
    simpleFsStorageProvider: vi.fn(),
    rustSdkCryptoStorageProvider: vi.fn(),
  }),
);

vi.mock("./send-queue.js", () => ({
  enqueueSend: async <T>(_roomId: string, fn: () => Promise<T>) => await fn(),
}));

vi.mock("./send/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send/client.js")>();
  return {
    ...actual,
    resolveMatrixClient: (...args: Parameters<typeof actual.resolveMatrixClient>) =>
      resolveMatrixClientMock(...args),
  };
});

const loadWebMediaMock = vi.fn().mockResolvedValue({
  buffer: Buffer.from("media"),
  fileName: "photo.png",
  contentType: "image/png",
  kind: "image",
});
const runtimeLoadConfigMock = vi.fn(() => ({}));
const mediaKindFromMimeMock = vi.fn(() => "image");
const isVoiceCompatibleAudioMock = vi.fn(() => false);
const getImageMetadataMock = vi.fn().mockResolvedValue(null);
const resizeToJpegMock = vi.fn();

const runtimeStub = {
  config: {
    loadConfig: runtimeLoadConfigMock,
  },
  media: {
    loadWebMedia: loadWebMediaMock as unknown as PluginRuntime["media"]["loadWebMedia"],
    mediaKindFromMime:
      mediaKindFromMimeMock as unknown as PluginRuntime["media"]["mediaKindFromMime"],
    isVoiceCompatibleAudio:
      isVoiceCompatibleAudioMock as unknown as PluginRuntime["media"]["isVoiceCompatibleAudio"],
    getImageMetadata: getImageMetadataMock as unknown as PluginRuntime["media"]["getImageMetadata"],
    resizeToJpeg: resizeToJpegMock as unknown as PluginRuntime["media"]["resizeToJpeg"],
  },
  channel: {
    text: {
      resolveTextChunkLimit: () => 4000,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

let sendMessageMatrix: typeof import("./send.js").sendMessageMatrix;
let resolveMediaMaxBytes: typeof import("./send/client.js").resolveMediaMaxBytes;
let sendTypingMatrix: typeof import("./send.js").sendTypingMatrix;

const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const client = {
    sendMessage,
    uploadContent,
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
  } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;
  return { client, sendMessage, uploadContent };
};

beforeAll(async () => {
  setMatrixRuntime(runtimeStub);
  ({ sendMessageMatrix } = await import("./send.js"));
  ({ resolveMediaMaxBytes } = await import("./send/client.js"));
  ({ sendTypingMatrix } = await import("./send.js"));
});

describe("sendMessageMatrix media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMatrixClientMock.mockImplementation(async (opts) => {
      if (!opts.client) {
        throw new Error("test expected a Matrix client");
      }
      return { client: opts.client, stopOnDone: false };
    });
    runtimeLoadConfigMock.mockReset();
    runtimeLoadConfigMock.mockReturnValue({});
    mediaKindFromMimeMock.mockReturnValue("image");
    isVoiceCompatibleAudioMock.mockReturnValue(false);
    setMatrixRuntime(runtimeStub);
  });

  it("uploads media with url payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient();

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(uploadArg)).toBe(true);

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      msgtype?: string;
      format?: string;
      formatted_body?: string;
    };
    expect(content.msgtype).toBe("m.image");
    expect(content.format).toBe("org.matrix.custom.html");
    expect(content.formatted_body).toContain("caption");
    expect(content.url).toBe("mxc://example/file");
  });

  it("uploads encrypted media with file payloads", async () => {
    const { client, sendMessage, uploadContent } = makeClient();
    (client as { crypto?: object }).crypto = {
      isRoomEncrypted: vi.fn().mockResolvedValue(true),
      encryptMedia: vi.fn().mockResolvedValue({
        buffer: Buffer.from("encrypted"),
        file: {
          key: {
            kty: "oct",
            key_ops: ["encrypt", "decrypt"],
            alg: "A256CTR",
            k: "secret",
            ext: true,
          },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
      }),
    };

    await sendMessageMatrix("room:!room:example", "caption", {
      client,
      mediaUrl: "file:///tmp/photo.png",
    });

    const uploadArg = uploadContent.mock.calls[0]?.[0] as Buffer | undefined;
    expect(uploadArg?.toString()).toBe("encrypted");

    const content = sendMessage.mock.calls[0]?.[1] as {
      url?: string;
      file?: { url?: string };
    };
    expect(content.url).toBeUndefined();
    expect(content.file?.url).toBe("mxc://example/file");
  });

  it("marks voice metadata and sends caption follow-up when audioAsVoice is compatible", async () => {
    const { client, sendMessage } = makeClient();
    mediaKindFromMimeMock.mockReturnValue("audio");
    isVoiceCompatibleAudioMock.mockReturnValue(true);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      fileName: "clip.mp3",
      contentType: "audio/mpeg",
      kind: "audio",
    });

    await sendMessageMatrix("room:!room:example", "voice caption", {
      client,
      mediaUrl: "file:///tmp/clip.mp3",
      audioAsVoice: true,
    });

    expect(isVoiceCompatibleAudioMock).toHaveBeenCalledWith({
      contentType: "audio/mpeg",
      fileName: "clip.mp3",
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const mediaContent = sendMessage.mock.calls[0]?.[1] as {
      msgtype?: string;
      body?: string;
      "org.matrix.msc3245.voice"?: Record<string, never>;
    };
    expect(mediaContent.msgtype).toBe("m.audio");
    expect(mediaContent.body).toBe("Voice message");
    expect(mediaContent["org.matrix.msc3245.voice"]).toEqual({});
  });

  it("keeps regular audio payload when audioAsVoice media is incompatible", async () => {
    const { client, sendMessage } = makeClient();
    mediaKindFromMimeMock.mockReturnValue("audio");
    isVoiceCompatibleAudioMock.mockReturnValue(false);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      fileName: "clip.wav",
      contentType: "audio/wav",
      kind: "audio",
    });

    await sendMessageMatrix("room:!room:example", "voice caption", {
      client,
      mediaUrl: "file:///tmp/clip.wav",
      audioAsVoice: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const mediaContent = sendMessage.mock.calls[0]?.[1] as {
      msgtype?: string;
      body?: string;
      "org.matrix.msc3245.voice"?: Record<string, never>;
    };
    expect(mediaContent.msgtype).toBe("m.audio");
    expect(mediaContent.body).toBe("voice caption");
    expect(mediaContent["org.matrix.msc3245.voice"]).toBeUndefined();
  });
});

describe("sendMessageMatrix threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeLoadConfigMock.mockReset();
    runtimeLoadConfigMock.mockReturnValue({});
    setMatrixRuntime(runtimeStub);
  });

  it("includes thread relation metadata when threadId is set", async () => {
    const { client, sendMessage } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello thread", {
      client,
      threadId: "$thread",
    });

    const content = sendMessage.mock.calls[0]?.[1] as {
      "m.relates_to"?: {
        rel_type?: string;
        event_id?: string;
        "m.in_reply_to"?: { event_id?: string };
      };
    };

    expect(content["m.relates_to"]).toMatchObject({
      rel_type: "m.thread",
      event_id: "$thread",
      "m.in_reply_to": { event_id: "$thread" },
    });
  });
});

describe("sendMessageMatrix cfg threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeLoadConfigMock.mockReset();
    runtimeLoadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          mediaMaxMb: 7,
        },
      },
    });
    setMatrixRuntime(runtimeStub);
  });

  it("does not call runtime loadConfig when cfg is provided", async () => {
    const { client } = makeClient();
    const providedCfg = {
      channels: {
        matrix: {
          mediaMaxMb: 4,
        },
      },
    };

    await sendMessageMatrix("room:!room:example", "hello cfg", {
      client,
      cfg: providedCfg as any,
    });

    expect(runtimeLoadConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to runtime loadConfig when cfg is omitted", async () => {
    const { client } = makeClient();

    await sendMessageMatrix("room:!room:example", "hello runtime", { client });

    expect(runtimeLoadConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMediaMaxBytes cfg threading", () => {
  beforeEach(() => {
    runtimeLoadConfigMock.mockReset();
    runtimeLoadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          mediaMaxMb: 9,
        },
      },
    });
    setMatrixRuntime(runtimeStub);
  });

  it("uses provided cfg and skips runtime loadConfig", () => {
    const providedCfg = {
      channels: {
        matrix: {
          mediaMaxMb: 3,
        },
      },
    };

    const maxBytes = resolveMediaMaxBytes(undefined, providedCfg as any);

    expect(maxBytes).toBe(3 * 1024 * 1024);
    expect(runtimeLoadConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to runtime loadConfig when cfg is omitted", () => {
    const maxBytes = resolveMediaMaxBytes();

    expect(maxBytes).toBe(9 * 1024 * 1024);
    expect(runtimeLoadConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendTypingMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMatrixClientMock.mockImplementation(async (opts) => {
      if (!opts.client) {
        throw new Error("test expected a Matrix client");
      }
      return { client: opts.client, stopOnDone: false };
    });
    setMatrixRuntime(runtimeStub);
  });

  it("sends default timeout for typing start", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    await sendTypingMatrix("!room:example.org", true, undefined, client);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", true, 30_000);
  });

  it("supports a custom typing timeout without changing the API meaning", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    await sendTypingMatrix("!room:example.org", true, { typingTimeoutMs: 5_000 }, client);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", true, 5_000);
  });

  it("preserves backward compatibility for legacy numeric timeouts", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    await sendTypingMatrix("!room:example.org", true, 5_000, client);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", true, 5_000);
  });

  it("accepts a Matrix client as the third argument", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    await sendTypingMatrix("!room:example.org", true, client);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", true, 30_000);
  });

  it("preserves legacy numeric timeout semantics when resolving the client internally", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    resolveMatrixClientMock.mockImplementationOnce(async (opts) => {
      expect(opts.client).toBeUndefined();
      expect(opts.timeoutMs).toBe(5_000);
      return {
        client: {
          setTyping,
        } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient,
        stopOnDone: false,
      };
    });

    await sendTypingMatrix("!room:example.org", true, 5_000);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", true, 5_000);
  });

  it("uses sdk typing stop semantics", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;

    await sendTypingMatrix("!room:example.org", false, undefined, client);

    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith("!room:example.org", false, 30_000);
  });
});
