import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuClientMockModule,
  createFeishuRuntimeMockModule,
} from "./monitor.test-mocks.js";
import {
  buildWebhookConfig,
  getFreePort,
  withRunningWebhookMonitor,
} from "./monitor.webhook.test-helpers.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => createFeishuClientMockModule());
vi.mock("./runtime.js", () => createFeishuRuntimeMockModule());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  adaptDefault: vi.fn(
    () => (_req: unknown, res: { statusCode?: number; end: (s: string) => void }) => {
      res.statusCode = 200;
      res.end("ok");
    },
  ),
}));

import {
  clearFeishuWebhookRateLimitStateForTest,
  getFeishuWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  monitorFeishuProvider,
  stopFeishuMonitor,
} from "./monitor.js";
afterEach(() => {
  clearFeishuWebhookRateLimitStateForTest();
  stopFeishuMonitor();
});

describe("Feishu webhook security hardening", () => {
  it("rejects webhook mode without verificationToken", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-token",
      path: "/hook-missing-token",
      port: await getFreePort(),
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(
      /requires verificationToken/i,
    );
  });

  it("rejects webhook mode without encryptKey", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });

    const cfg = buildWebhookConfig({
      accountId: "missing-encrypt-key",
      path: "/hook-missing-encrypt",
      port: await getFreePort(),
      verificationToken: "verify_token",
    });

    await expect(monitorFeishuProvider({ config: cfg })).rejects.toThrow(/requires encryptKey/i);
  });

  it("returns 415 for POST requests without json content type", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "content-type",
        path: "/hook-content-type",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        });

        expect(response.status).toBe(415);
        expect(await response.text()).toBe("Unsupported Media Type");
      },
    );
  });

  it("rejects oversized unsigned webhook bodies with 413 before signature verification", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "payload-too-large",
        path: "/hook-payload-too-large",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload: "x".repeat(70 * 1024) }),
        });

        expect(response.status).toBe(413);
        expect(await response.text()).toBe("Payload too large");
      },
    );
  });

  it("drops slow-body webhook requests within the tightened pre-auth timeout", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "slow-body-timeout",
        path: "/hook-slow-body-timeout",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        const result = await waitForSlowBodyTimeoutResponse(url, 15_000);
        expect(result.body).toContain("408 Request Timeout");
        expect(result.body).toContain("Request body timeout");
        expect(result.elapsedMs).toBeLessThan(12_000);
      },
    );
  });

  it("rate limits webhook burst traffic with 429", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    await withRunningWebhookMonitor(
      {
        accountId: "rate-limit",
        path: "/hook-rate-limit",
        verificationToken: "verify_token",
        encryptKey: "encrypt_key",
      },
      monitorFeishuProvider,
      async (url) => {
        let saw429 = false;
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          });
          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }
        }

        expect(saw429).toBe(true);
      },
    );
  });

  it("marks webhook accounts connected once the server starts listening", async () => {
    probeFeishuMock.mockResolvedValue({ ok: true, botOpenId: "bot_open_id" });
    const statusSink = vi.fn();
    const port = await getFreePort();
    const cfg = buildWebhookConfig({
      accountId: "webhook-connected",
      path: "/hook-connected",
      port,
      verificationToken: "verify_token",
      encryptKey: "encrypt_key",
    });
    const abortController = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const monitorPromise = monitorFeishuProvider({
      config: cfg,
      runtime,
      abortSignal: abortController.signal,
      statusSink,
    });

    try {
      await vi.waitFor(() => {
        expect(statusSink).toHaveBeenCalledWith(
          expect.objectContaining({
            connected: true,
            reconnectAttempts: 0,
            lastConnectedAt: expect.any(Number),
            lastDisconnect: null,
            lastError: null,
          }),
        );
      });
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("caps tracked webhook rate-limit keys to prevent unbounded growth", () => {
    const now = 1_000_000;
    for (let i = 0; i < 4_500; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBeLessThanOrEqual(4_096);
  });

  it("prunes stale webhook rate-limit state after window elapses", () => {
    const now = 2_000_000;
    for (let i = 0; i < 100; i += 1) {
      isWebhookRateLimitedForTest(`/feishu-rate-limit-stale:key-${i}`, now);
    }
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(100);

    isWebhookRateLimitedForTest("/feishu-rate-limit-stale:fresh", now + 60_001);
    expect(getFeishuWebhookRateLimitStateSizeForTest()).toBe(1);
  });
});
