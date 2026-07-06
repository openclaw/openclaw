// Discord tests cover retry plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDiscordDeliveryRetryAfterMs,
  isRetryableDiscordDeliveryError,
  withDiscordDeliveryRetry,
} from "./delivery-retry.js";
import { DiscordError, RateLimitError } from "./internal/discord.js";
import type { GatewayPlugin } from "./internal/gateway.js";
import { clearGateways, registerGateway } from "./monitor/gateway-registry.js";
import { createDiscordRetryRunner, isRetryableDiscordTransientError } from "./retry.js";

const ZERO_DELAY_RETRY = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

function createRateLimitError(retryAfter = 0): RateLimitError {
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "bucket-1",
    },
  });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, {
    message: "rate limited",
    retry_after: retryAfter,
    global: false,
  });
}

describe("isRetryableDiscordTransientError", () => {
  it.each([
    ["rate limit", createRateLimitError()],
    ["408 status", Object.assign(new Error("request timeout"), { status: 408 })],
    ["502 status", Object.assign(new Error("bad gateway"), { status: 502 })],
    ["503 statusCode", Object.assign(new Error("service unavailable"), { statusCode: 503 })],
    [
      "signed string statusCode",
      Object.assign(new Error("service unavailable"), { statusCode: "+503" }),
    ],
    ["fetch failed", new TypeError("fetch failed")],
    ["ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["ETIMEDOUT cause", new Error("request failed", { cause: { code: "ETIMEDOUT" } })],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ])("retries %s", (_name, err) => {
    expect(isRetryableDiscordTransientError(err)).toBe(true);
  });

  it.each([
    ["400 status", Object.assign(new Error("bad request"), { status: 400 })],
    ["fractional status", Object.assign(new Error("upstream rejected request"), { status: 500.5 })],
    ["403 status", Object.assign(new Error("missing permissions"), { statusCode: 403 })],
    ["unknown channel", new Error("Unknown Channel")],
    ["plain string", "fetch failed"],
  ])("does not retry %s", (_name, err) => {
    expect(isRetryableDiscordTransientError(err)).toBe(false);
  });
});

describe("createDiscordRetryRunner", () => {
  it("retries transient transport errors", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "send")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after configured transient retry attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "send")).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isRetryableDiscordDeliveryError", () => {
  it("retries status-coded errors from injected delivery dependencies", () => {
    expect(
      isRetryableDiscordDeliveryError(Object.assign(new Error("bad gateway"), { status: 502 })),
    ).toBe(true);
  });

  it("does not retry Discord client errors after the request runner handled them", () => {
    const err = new DiscordError(new Response("upstream", { status: 502 }), {
      message: "Bad Gateway",
    });

    expect(isRetryableDiscordDeliveryError(err)).toBe(false);
  });

  it("retries statusless transport errors while the gateway is disconnected", () => {
    expect(
      isRetryableDiscordDeliveryError(new TypeError("fetch failed"), {
        gatewayDisconnected: true,
      }),
    ).toBe(true);
  });

  it("keeps Discord client errors non-retryable while the gateway is disconnected", () => {
    const err = new DiscordError(new Response("upstream", { status: 404 }), {
      message: "Unknown Channel",
    });

    expect(isRetryableDiscordDeliveryError(err, { gatewayDisconnected: true })).toBe(false);
  });
});

describe("withDiscordDeliveryRetry gateway reconnect window", () => {
  const cfg = {
    channels: {
      discord: { retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 } },
    },
  } as OpenClawConfig;

  afterEach(() => {
    clearGateways();
  });

  it("retries transport errors while the registered gateway is disconnected", async () => {
    registerGateway("default", { isConnected: false } as GatewayPlugin);
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue("ok");

    await expect(withDiscordDeliveryRetry({ cfg, fn })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry statusless errors while the gateway is connected", async () => {
    registerGateway("default", { isConnected: true } as GatewayPlugin);
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(withDiscordDeliveryRetry({ cfg, fn })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("getDiscordDeliveryRetryAfterMs", () => {
  it("reads finite retry delays from delivery errors", () => {
    expect(getDiscordDeliveryRetryAfterMs({ retryAfter: 0.25 })).toBe(250);
    expect(getDiscordDeliveryRetryAfterMs({ headers: { "retry-after": "0.25" } })).toBe(250);
  });

  it("rejects unsafe retry delay magnitudes", () => {
    expect(getDiscordDeliveryRetryAfterMs({ retryAfter: 9_007_199_254_741 })).toBeUndefined();
    expect(
      getDiscordDeliveryRetryAfterMs({ headers: { "retry-after": "9007199254741" } }),
    ).toBeUndefined();
  });
});
