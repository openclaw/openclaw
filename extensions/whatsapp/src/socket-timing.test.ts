import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
// Whatsapp tests cover socket timing plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  WhatsAppSocketOperationTimeoutError,
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

  it("marks operation timeout errors as unknown delivery state", () => {
    const error = new WhatsAppSocketOperationTimeoutError(
      "sendMessage",
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );

    expect(error).toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "sendMessage",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      deliveryState: "unknown",
    });
    expect(isWhatsAppSocketOperationTimeoutError(error)).toBe(true);
  });

  it("clamps oversized operation timeouts before scheduling timers", async () => {
    expect(resolveWhatsAppSocketOperationTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});

describe("withWhatsAppSocketOperationTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a stalled readMessages socket operation with a typed timeout", async () => {
    vi.useFakeTimers();
    // A WhatsApp read-receipt call that never resolves (socket stall).
    const stalled = new Promise<void>(() => {});
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      stalled,
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    const rejection = expect(bounded).rejects.toMatchObject({
      name: "WhatsAppSocketOperationTimeoutError",
      operation: "readMessages",
      timeoutMs: DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
      deliveryState: "unknown",
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs);
    await rejection;
    // The bounding timer is cleared once the operation settles.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves the operation value when it settles before the bound", async () => {
    vi.useFakeTimers();
    const bounded = withWhatsAppSocketOperationTimeout(
      "readMessages",
      Promise.resolve("read"),
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
    );
    await expect(bounded).resolves.toBe("read");
    expect(vi.getTimerCount()).toBe(0);
  });
});
