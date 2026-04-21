import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSynologyChatAccount } from "./types.js";

const fetchRemoteMediaMock = vi.fn();

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  fetchRemoteMedia: fetchRemoteMediaMock,
}));

const {
  clearSynologyHostedMediaStateForTest,
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
      url: "https://example.com/file.png",
    });
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
    registerSynologyHostedMediaTransport(testAccount);
    rememberSynologyHostedMediaOrigin(testAccount, "https://hooks.example.com");

    const resolved = await resolveSynologyWebhookFileUrl({
      account: testAccount,
      sourceUrl: "https://example.com/file.png",
    });

    expect(resolved).toMatch(
      /^https:\/\/hooks\.example\.com\/webhook\/synology\/__openclaw-media\/.+$/,
    );
  });
});
