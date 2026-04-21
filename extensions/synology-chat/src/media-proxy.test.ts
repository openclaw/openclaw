import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSynologyChatAccount } from "./types.js";

const fetchRemoteMediaMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MEDIA_MAX_BYTES: 5 * 1024 * 1024,
  fetchRemoteMedia: fetchRemoteMediaMock,
}));

const {
  createSynologyHostedMediaHandler,
  clearSynologyHostedMediaStateForTest,
  deriveSynologyPublicOrigin,
  registerSynologyHostedMediaTransport,
  rememberSynologyHostedMediaOrigin,
  resolveSynologyWebhookFileUrl,
} = await import("./media-proxy.js");

const testAccount: ResolvedSynologyChatAccount = {
  accountId: "default",
  enabled: true,
  token: "token",
  incomingUrl: "https://nas.example.com/incoming",
  nasHost: "nas.example.com",
  publicOrigin: undefined,
  webhookPath: "/webhook/synology",
  webhookPathSource: "default",
  dangerouslyAllowNameMatching: false,
  dangerouslyAllowInheritedWebhookPath: false,
  dmPolicy: "open",
  allowedUserIds: [],
  rateLimitPerMinute: 30,
  botName: "Bot",
  allowInsecureSsl: false,
};

describe("resolveSynologyWebhookFileUrl", () => {
  beforeEach(() => {
    clearSynologyHostedMediaStateForTest();
    vi.unstubAllEnvs();
    fetchRemoteMediaMock.mockReset();
    fetchRemoteMediaMock.mockResolvedValue({
      buffer: Buffer.from("image-bytes"),
      contentType: "image/png",
      fileName: "file.png",
    });
  });

  afterEach(() => {
    clearSynologyHostedMediaStateForTest();
    vi.unstubAllEnvs();
  });

  it("uses a configured public origin to bootstrap hostname-backed media before the first inbound webhook", async () => {
    registerSynologyHostedMediaTransport({
      ...testAccount,
      publicOrigin: "https://gateway-config.example.com",
    });

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toMatch(
      /^https:\/\/gateway-config\.example\.com\/webhook\/synology\/__openclaw-media\/.+$/,
    );
    expect(fetchRemoteMediaMock).toHaveBeenCalledWith({
      maxBytes: 32 * 1024 * 1024,
      url: "https://example.com/file.png",
    });
  });

  it("does not mint hosted-media tokens before the gateway transport is registered", async () => {
    const resolved = await resolveSynologyWebhookFileUrl({
      account: {
        ...testAccount,
        publicOrigin: "https://gateway-config.example.com",
      },
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toBeNull();
    expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("uses OPENCLAW_GATEWAY_URL to bootstrap hostname-backed media before the first inbound webhook", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway.example.com/ws");
    registerSynologyHostedMediaTransport(testAccount);

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toMatch(
      /^https:\/\/gateway\.example\.com\/webhook\/synology\/__openclaw-media\/.+$/,
    );
    expect(fetchRemoteMediaMock).toHaveBeenCalledWith({
      maxBytes: 32 * 1024 * 1024,
      url: "https://example.com/file.png",
    });
  });

  it("evicts oldest hosted media when the total byte budget is exceeded", async () => {
    const largeBuffer = Buffer.alloc(24 * 1024 * 1024, 1);
    fetchRemoteMediaMock.mockResolvedValue({
      buffer: largeBuffer,
      contentType: "image/png",
      fileName: "file.png",
    });
    registerSynologyHostedMediaTransport({
      ...testAccount,
      publicOrigin: "https://gateway-config.example.com",
    });

    const firstUrl = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file-1.png",
    });
    const secondUrl = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file-2.png",
    });
    const thirdUrl = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file-3.png",
    });

    const handler = createSynologyHostedMediaHandler(testAccount);
    const firstRes = createMockResponseRecorder();
    await handler({ method: "GET", url: new URL(firstUrl!).pathname } as never, firstRes as never);
    expect(firstRes.statusCode).toBe(404);

    const thirdRes = createMockResponseRecorder();
    await handler({ method: "GET", url: new URL(thirdUrl!).pathname } as never, thirdRes as never);
    expect(thirdRes.statusCode).toBe(200);

    expect(secondUrl).toBeTruthy();
  });

  it("ignores loopback gateway urls for bootstrap origin seeding", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789/ws");
    registerSynologyHostedMediaTransport(testAccount);

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toBeNull();
    expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("prefers the observed webhook origin over the bootstrap gateway origin", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://gateway.example.com/ws");
    registerSynologyHostedMediaTransport({
      ...testAccount,
      publicOrigin: "https://gateway-config.example.com",
    });
    rememberSynologyHostedMediaOrigin(testAccount, "https://hooks.example.com");

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toMatch(
      /^https:\/\/hooks\.example\.com\/webhook\/synology\/__openclaw-media\/.+$/,
    );
  });

  it("ignores learned private origins and keeps the previous safe hosted-media origin", async () => {
    registerSynologyHostedMediaTransport({
      ...testAccount,
      publicOrigin: "https://gateway-config.example.com",
    });
    rememberSynologyHostedMediaOrigin(testAccount, "http://127.0.0.1:3000");

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toMatch(
      /^https:\/\/gateway-config\.example\.com\/webhook\/synology\/__openclaw-media\/.+$/,
    );
  });

  it("uses the last forwarded host and proto values when deriving the public origin", () => {
    const origin = deriveSynologyPublicOrigin({
      headers: {
        host: "ignored.example.com",
        "x-forwarded-host": "attacker.example.com, openclaw.example.com",
        "x-forwarded-proto": "http, https",
      },
      socket: {},
    } as never);

    expect(origin).toBe("https://openclaw.example.com");
  });

  it("rejects origin learning when only a raw Host header is present", () => {
    const origin = deriveSynologyPublicOrigin({
      headers: {
        host: "openclaw.example.com",
      },
      socket: { encrypted: true },
    } as never);

    expect(origin).toBeUndefined();
  });

  it("rejects learned private origins derived from webhook headers", () => {
    const origin = deriveSynologyPublicOrigin({
      headers: {
        "x-forwarded-host": "127.0.0.1:3000",
        "x-forwarded-proto": "https",
      },
      socket: {},
    } as never);

    expect(origin).toBeUndefined();
  });
});

function createMockResponseRecorder() {
  return {
    statusCode: 0,
    headers: undefined as Record<string, string | number> | undefined,
    body: undefined as unknown,
    writeHead(statusCode: number, headers?: Record<string, string | number>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body?: unknown) {
      this.body = body;
      return this;
    },
  };
}
