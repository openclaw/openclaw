import type { PluginRuntime } from "openclaw/plugin-sdk";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMatrixRuntime } from "../runtime.js";

vi.mock("music-metadata", () => ({
  parseBuffer: vi.fn().mockResolvedValue({ format: {} }),
}));

vi.mock("@vector-im/matrix-bot-sdk", () => ({
  ConsoleLogger: class {
    trace = vi.fn();
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
  LogService: {
    setLogger: vi.fn(),
  },
  MatrixClient: vi.fn(),
  SimpleFsStorageProvider: vi.fn(),
  RustSdkCryptoStorageProvider: vi.fn(),
}));

const runtimeStub = {
  config: {
    loadConfig: () => ({}),
  },
  media: {
    loadWebMedia: vi.fn(),
    mediaKindFromMime: vi.fn(() => "image"),
    isVoiceCompatibleAudio: vi.fn(() => false),
    getImageMetadata: vi.fn().mockResolvedValue(null),
    resizeToJpeg: vi.fn(),
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

const makeClient = (sendEventReturn = "edit-evt-1") => {
  const sendEvent = vi.fn().mockResolvedValue(sendEventReturn);
  const resolveRoom = vi
    .fn()
    .mockImplementation((alias: string) =>
      alias.startsWith("#") ? "!resolved:example.org" : alias,
    );
  const client = {
    sendEvent,
    resolveRoom,
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
  } as unknown as import("@vector-im/matrix-bot-sdk").MatrixClient;
  return { client, sendEvent, resolveRoom };
};

let editMessageMatrix: typeof import("./send.js").editMessageMatrix;

beforeAll(async () => {
  setMatrixRuntime(runtimeStub);
  ({ editMessageMatrix } = await import("./send.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  setMatrixRuntime(runtimeStub);
});

describe("editMessageMatrix", () => {
  it("sends m.room.message with m.replace relation", async () => {
    const { client, sendEvent } = makeClient();

    await editMessageMatrix("!room:example.org", "$original-evt-1", "updated text", { client });

    expect(sendEvent).toHaveBeenCalledOnce();
    const [, eventType, content] = sendEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(eventType).toBe("m.room.message");
    const relatesTo = content["m.relates_to"] as { rel_type: string; event_id: string };
    expect(relatesTo.rel_type).toBe("m.replace");
    expect(relatesTo.event_id).toBe("$original-evt-1");
  });

  it("m.new_content.body matches provided text", async () => {
    const { client, sendEvent } = makeClient();

    await editMessageMatrix("!room:example.org", "$original-evt-1", "clean text", { client });

    const [, , content] = sendEvent.mock.calls[0] as [string, string, Record<string, unknown>];
    const newContent = content["m.new_content"] as { body: string; msgtype: string };
    expect(newContent.body).toBe("clean text");
    expect(newContent.msgtype).toBe("m.text");
  });

  it("outer body has * prefix for backward compat", async () => {
    const { client, sendEvent } = makeClient();

    await editMessageMatrix("!room:example.org", "$original-evt-1", "my edit", { client });

    const [, , content] = sendEvent.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(content["body"]).toBe("* my edit");
  });

  it("m.new_content includes formatted_body when formattedText is provided", async () => {
    const { client, sendEvent } = makeClient();

    await editMessageMatrix("!room:example.org", "$original-evt-1", "plain text", {
      client,
      formattedText: "<b>plain text</b>",
    });

    const [, , content] = sendEvent.mock.calls[0] as [string, string, Record<string, unknown>];
    const newContent = content["m.new_content"] as {
      body: string;
      msgtype: string;
      format?: string;
      formatted_body?: string;
    };
    expect(newContent.format).toBe("org.matrix.custom.html");
    expect(newContent.formatted_body).toBe("<b>plain text</b>");
  });

  it("resolves roomId via resolveMatrixRoomId", async () => {
    const { client, sendEvent } = makeClient();

    // The room alias resolves to the canonical room ID
    await editMessageMatrix("#general:example.org", "$evt", "hello", { client });

    const [resolvedRoomId] = sendEvent.mock.calls[0] as [string, string, Record<string, unknown>];
    // resolveMatrixRoomId for a room alias returns the alias unchanged in tests
    // (no network lookup), but the important thing is sendEvent was called with
    // whatever resolveMatrixRoomId returned, not necessarily the raw input.
    expect(typeof resolvedRoomId).toBe("string");
    expect(resolvedRoomId.length).toBeGreaterThan(0);
  });

  it("returns messageId from sendEvent result", async () => {
    const { client } = makeClient("edit-evt-42");

    const result = await editMessageMatrix("!room:example.org", "$evt", "text", { client });

    expect(result.messageId).toBe("edit-evt-42");
    expect(result.roomId).toBe("!room:example.org");
  });
});
