import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const getWebhookInfoMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const deleteWebhookMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const setWebhookMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, result: { url: "" } })));
const getUpdatesMock = vi.hoisted(() => vi.fn(() => new Promise(() => {})));
const getZaloRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getUpdates: getUpdatesMock,
    getWebhookInfo: getWebhookInfoMock,
    setWebhook: setWebhookMock,
  };
});

vi.mock("./runtime.js", () => ({
  getZaloRuntime: getZaloRuntimeMock,
}));

const TEST_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "zalo-token", // pragma: allowlist secret
  tokenSource: "config",
  config: {
    dmPolicy: "open",
  },
};

const TEST_CONFIG = {
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          enabled: true,
          dmPolicy: "open",
        },
      },
    },
  },
} as OpenClawConfig;

function createRuntimeEnv() {
  return {
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

describe("Zalo polling image handling", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const fetchRemoteMediaMock = vi.fn(async () => ({
    buffer: Buffer.from("image-bytes"),
    contentType: "image/jpeg",
  }));
  const saveMediaBufferMock = vi.fn(async () => ({
    path: "/tmp/zalo-photo.jpg",
    contentType: "image/jpeg",
  }));

  beforeEach(() => {
    vi.clearAllMocks();

    getZaloRuntimeMock.mockReturnValue(
      createPluginRuntimeMock({
        channel: {
          media: {
            fetchRemoteMedia:
              fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
            saveMediaBuffer:
              saveMediaBufferMock as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
          },
          reply: {
            finalizeInboundContext:
              finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyWithBufferedBlockDispatcher: vi.fn(
              async () => undefined,
            ) as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
          },
          session: {
            recordInboundSession:
              recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
          },
          commands: {
            shouldComputeCommandAuthorized: vi.fn(
              () => false,
            ) as unknown as PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"],
            resolveCommandAuthorizedFromAuthorizers: vi.fn(
              () => false,
            ) as unknown as PluginRuntime["channel"]["commands"]["resolveCommandAuthorizedFromAuthorizers"],
            isControlCommandMessage: vi.fn(
              () => false,
            ) as unknown as PluginRuntime["channel"]["commands"]["isControlCommandMessage"],
          },
        },
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: {
          event_name: "message.image.received",
          message: {
            chat: {
              id: "chat-123",
              chat_type: "PRIVATE" as const,
            },
            message_id: "msg-123",
            date: 1774084566880,
            message_type: "CHAT_PHOTO",
            from: {
              id: "user-123",
              is_bot: false,
              display_name: "Test User",
            },
            photo_url: "https://example.com/test-image.jpg",
            caption: "",
          },
        },
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await import("./monitor.js");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account: TEST_ACCOUNT,
      config: TEST_CONFIG,
      runtime,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() =>
      expect(fetchRemoteMediaMock).toHaveBeenCalledWith({
        url: "https://example.com/test-image.jpg",
        maxBytes: 5 * 1024 * 1024,
      }),
    );
    expect(saveMediaBufferMock).toHaveBeenCalledTimes(1);
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        SenderName: "Test User",
        MediaPath: "/tmp/zalo-photo.jpg",
        MediaType: "image/jpeg",
      }),
    );
    expect(recordInboundSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          SenderName: "Test User",
          MediaPath: "/tmp/zalo-photo.jpg",
          MediaType: "image/jpeg",
        }),
      }),
    );

    abort.abort();
    await run;
  });
});
