import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { VoiceCallWebhookServer } from "./webhook.js";

function makeConfig(port: number): VoiceCallConfig {
  return {
    serve: { port, bind: "127.0.0.1", path: "/voice/webhook" },
  } as unknown as VoiceCallConfig;
}

const stubManager = {} as CallManager;
const stubProvider = {} as VoiceCallProvider;

/**
 * Create an EADDRINUSE error matching what Node emits.
 */
function eaddrinuse(port: number): NodeJS.ErrnoException {
  const err = new Error(
    `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
  ) as NodeJS.ErrnoException;
  err.code = "EADDRINUSE";
  return err;
}

describe("VoiceCallWebhookServer EADDRINUSE retry", () => {
  let webhook: VoiceCallWebhookServer | null = null;
  // Track the real listen so we can restore it
  const realListen = http.Server.prototype.listen;

  afterEach(async () => {
    // Restore listen
    http.Server.prototype.listen = realListen;
    vi.restoreAllMocks();
    if (webhook) {
      await webhook.stop();
      webhook = null;
    }
  });

  /**
   * Patch http.Server.prototype.listen to simulate EADDRINUSE for specific ports.
   * The server "error" event fires asynchronously with EADDRINUSE for blocked ports.
   * For other ports, the real listen is called.
   */
  function blockPorts(blocked: Set<number>): void {
    http.Server.prototype.listen = function patchedListen(
      this: http.Server,
      ...args: unknown[]
    ): http.Server {
      const port = typeof args[0] === "number" ? args[0] : undefined;
      if (port !== undefined && blocked.has(port)) {
        // Simulate async EADDRINUSE
        setImmediate(() => {
          this.emit("error", eaddrinuse(port));
        });
        return this;
      }
      // Call real listen
      return realListen.apply(this, args as Parameters<typeof realListen>);
    } as typeof realListen;
  }

  it("falls back to next port when configured port is occupied", async () => {
    blockPorts(new Set([40000]));
    webhook = new VoiceCallWebhookServer(makeConfig(40000), stubManager, stubProvider);
    const url = await webhook.start();
    expect(url).toBe("http://127.0.0.1:40001/voice/webhook");
  });

  it("skips multiple occupied ports", async () => {
    blockPorts(new Set([40010, 40011]));
    webhook = new VoiceCallWebhookServer(makeConfig(40010), stubManager, stubProvider);
    const url = await webhook.start();
    expect(url).toBe("http://127.0.0.1:40012/voice/webhook");
  });

  it("throws after exhausting retries", async () => {
    blockPorts(new Set([40020, 40021, 40022, 40023]));
    webhook = new VoiceCallWebhookServer(makeConfig(40020), stubManager, stubProvider);
    await expect(webhook.start()).rejects.toThrow("EADDRINUSE");
  });

  it("starts on configured port when available", async () => {
    blockPorts(new Set()); // nothing blocked
    webhook = new VoiceCallWebhookServer(makeConfig(40030), stubManager, stubProvider);
    const url = await webhook.start();
    expect(url).toBe("http://127.0.0.1:40030/voice/webhook");
  });
});
