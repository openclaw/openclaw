import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const cfg = { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig;
const opts = { cfg, webhookId: "1", webhookToken: "t", wait: true as const };

describe("sendWebhookMessageDiscord timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a hanging loopback webhook that never returns headers", async () => {
    let requests = 0;
    const server = http.createServer(() => {
      requests += 1;
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const timeoutMs = 250;
    const orig = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return orig(url.replace("https://discord.com", baseUrl), init);
    });
    const t0 = Date.now();
    await expect(sendWebhookMessageDiscord("hi", { ...opts, timeoutMs })).rejects.toThrow(
      /timed out|abort/i,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(requests).toBe(1);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
});
