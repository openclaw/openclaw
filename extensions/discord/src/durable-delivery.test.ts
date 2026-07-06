// Discord tests cover durable delivery plugin behavior.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
});

describe("durable Discord delivery", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: discordPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("fans out planned text chunks and retries a transient failure on a later chunk", async () => {
    hoisted.sendMessageDiscordMock
      .mockResolvedValueOnce({
        messageId: "msg-chunk-1",
        channelId: "ch-1",
      })
      .mockRejectedValueOnce(Object.assign(new Error("discord 500"), { status: 500 }))
      .mockResolvedValueOnce({
        messageId: "msg-chunk-2",
        channelId: "ch-1",
      });

    const result = await sendDurableMessageBatch({
      cfg: {
        channels: {
          discord: {
            token: "test-token",
            retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
          },
        },
      },
      channel: "discord",
      to: "channel:123456",
      payloads: [{ text: "first chunk\nsecond chunk" }],
      formatting: {
        chunkMode: "newline",
        maxLinesPerMessage: 1,
        textLimit: 2000,
      },
      skipQueue: true,
    });

    expect(result.status).toBe("sent");
    if (result.status !== "sent") {
      throw new Error("expected durable Discord send to succeed");
    }
    expect(
      result.results.map((entry) => ({
        channel: entry.channel,
        messageId: entry.messageId,
      })),
    ).toEqual([
      { channel: "discord", messageId: "msg-chunk-1" },
      { channel: "discord", messageId: "msg-chunk-2" },
    ]);
    expect(result.receipt.platformMessageIds).toEqual(["msg-chunk-1", "msg-chunk-2"]);
    expect(result.payloadOutcomes).toEqual([
      {
        index: 0,
        status: "sent",
        results: result.results,
      },
    ]);
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledTimes(3);
    expect(hoisted.sendMessageDiscordMock.mock.calls.map((call) => call[1])).toEqual([
      "first chunk",
      "second chunk",
      "second chunk",
    ]);
  });

  it("declares reconcileUnknownSend adapter for reconnect drain recovery", () => {
    const durable = (discordPlugin.message as Record<string, unknown>).durableFinal as
      | Record<string, unknown>
      | undefined;
    expect(durable).toBeDefined();
    expect(durable).toHaveProperty("reconcileUnknownSend");
    expect(typeof durable?.reconcileUnknownSend).toBe("function");
    const capabilities = durable?.capabilities as Record<string, unknown> | undefined;
    expect(capabilities?.reconcileUnknownSend).toBe(true);
  });

  it("returns not_sent when lastError is a connection-phase failure", async () => {
    const durable = (discordPlugin.message as Record<string, unknown>).durableFinal as
      | { reconcileUnknownSend?: Function }
      | undefined;
    expect(durable?.reconcileUnknownSend).toBeDefined();
    const result = await durable!.reconcileUnknownSend!({
      cfg: {},
      queueId: "test-q",
      channel: "discord",
      to: "channel:1",
      enqueuedAt: Date.now(),
      retryCount: 0,
      payloads: [{ text: "t" }],
      lastError: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(result).toEqual({ status: "not_sent" });
  });

  it("returns unresolved when lastError is not a connection-phase error", async () => {
    const durable = (discordPlugin.message as Record<string, unknown>).durableFinal as
      | { reconcileUnknownSend?: Function }
      | undefined;
    expect(durable?.reconcileUnknownSend).toBeDefined();
    const result = await durable!.reconcileUnknownSend!({
      cfg: {},
      queueId: "test-q",
      channel: "discord",
      to: "channel:1",
      enqueuedAt: Date.now(),
      retryCount: 0,
      payloads: [{ text: "t" }],
      lastError: "HTTP 500 Internal Server Error",
    });
    const unresolved = result as { status: string; error: string; retryable: boolean };
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.retryable).toBe(false);
  });

  it("returns unresolved when lastError is missing and retryCount > 0", async () => {
    const durable = (discordPlugin.message as Record<string, unknown>).durableFinal as
      | { reconcileUnknownSend?: Function }
      | undefined;
    expect(durable?.reconcileUnknownSend).toBeDefined();
    const result = await durable!.reconcileUnknownSend!({
      cfg: {},
      queueId: "test-q",
      channel: "discord",
      to: "channel:1",
      enqueuedAt: Date.now(),
      retryCount: 2,
      payloads: [{ text: "t" }],
    });
    const unresolved = result as { status: string; error: string; retryable: boolean };
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.retryable).toBe(false);
  });

  it("keeps ETIMEDOUT unresolved (can be post-dispatch response timeout)", async () => {
    const durable = (discordPlugin.message as Record<string, unknown>).durableFinal as
      | { reconcileUnknownSend?: Function }
      | undefined;
    expect(durable?.reconcileUnknownSend).toBeDefined();
    const result = await durable!.reconcileUnknownSend!({
      cfg: {},
      queueId: "test-q",
      channel: "discord",
      to: "channel:1",
      enqueuedAt: Date.now(),
      retryCount: 0,
      payloads: [{ text: "t" }],
      lastError: "fetch failed | ETIMEDOUT",
    });
    const unresolved = result as { status: string; error: string; retryable: boolean };
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.retryable).toBe(false);
  });
});
