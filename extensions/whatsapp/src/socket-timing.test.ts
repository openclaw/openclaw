import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
// Whatsapp tests cover socket timing plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  WhatsAppSocketOperationTimeoutError,
  createWhatsAppSocketOperationTimeoutAdapter,
  isWhatsAppSocketOperationTimeoutError,
  resolveWhatsAppSocketOperationTimeoutMs,
  resolveWhatsAppSocketTiming,
  withWhatsAppSocketOperationTimeout,
} from "./socket-timing.js";

describe("resolveWhatsAppSocketTiming", () => {
  it("uses OpenClaw's explicit WhatsApp Web socket defaults", () => {
    expect(resolveWhatsAppSocketTiming({})).toEqual(DEFAULT_WHATSAPP_SOCKET_TIMING);
  });

  it("reads Baileys timing values from web.whatsapp config", () => {
    expect(
      resolveWhatsAppSocketTiming({
        web: {
          whatsapp: {
            keepAliveIntervalMs: 10_000,
            connectTimeoutMs: 90_000,
            defaultQueryTimeoutMs: 120_000,
          },
        },
      }),
    ).toEqual({
      keepAliveIntervalMs: 10_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });

  it("lets call-site overrides take precedence over config", () => {
    expect(
      resolveWhatsAppSocketTiming(
        {
          web: {
            whatsapp: {
              keepAliveIntervalMs: 10_000,
              connectTimeoutMs: 90_000,
              defaultQueryTimeoutMs: 120_000,
            },
          },
        },
        {
          keepAliveIntervalMs: 20_000,
        },
      ),
    ).toEqual({
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 120_000,
    });
  });

  it("uses the configured operation bound without rejecting slow successful sends", async () => {
    vi.useFakeTimers();
    try {
      const operation = withWhatsAppSocketOperationTimeout(
        "sendMessage",
        new Promise((resolve) => {
          setTimeout(() => resolve("accepted"), 45_000);
        }),
        DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      );

      await vi.advanceTimersByTimeAsync(45_000);

      await expect(operation).resolves.toBe("accepted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks timed-out sends as unknown delivery state", async () => {
    vi.useFakeTimers();
    try {
      const operation = withWhatsAppSocketOperationTimeout(
        "sendMessage",
        new Promise(() => {}),
        DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      );

      const expectation = expect(operation).rejects.toMatchObject({
        name: "WhatsAppSocketOperationTimeoutError",
        operation: "sendMessage",
        timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
        deliveryState: "unknown",
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
      await expectation;

      const error = new WhatsAppSocketOperationTimeoutError(
        "sendMessage",
        DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      );
      expect(isWhatsAppSocketOperationTimeoutError(error)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized operation timeouts before scheduling timers", async () => {
    expect(resolveWhatsAppSocketOperationTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("wraps socket send and presence operations with the timeout contract", async () => {
    const sock = {
      sendMessage: vi.fn(async () => ({ key: { id: "message-1" } })),
      sendPresenceUpdate: vi.fn(async () => undefined),
    };
    const adapter = createWhatsAppSocketOperationTimeoutAdapter(sock, 500);

    await expect(adapter.sendMessage("1555@s.whatsapp.net", { text: "hi" })).resolves.toEqual({
      key: { id: "message-1" },
    });
    await expect(adapter.sendPresenceUpdate("composing", "1555@s.whatsapp.net")).resolves.toBe(
      undefined,
    );
    expect(sock.sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", { text: "hi" });
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("composing", "1555@s.whatsapp.net");
  });
});
