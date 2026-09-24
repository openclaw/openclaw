import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { callGatewayFromCli } from "./core-api.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn<typeof callGatewayFromCli>(async () => ({ ok: true })),
}));

vi.mock("./core-api.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const { callBrowserRequest } = await import("./browser-cli-shared.js");

describe("callBrowserRequest", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayFromCli.mockClear();
  });

  it("receives the browser timeout diagnostic before its Gateway transport watchdog", async () => {
    vi.useFakeTimers();
    const requestTimeoutMs = 50;
    const diagnostic = new Error("browser proxy timed out for GET /snapshot after 50ms");
    gatewayMocks.callGatewayFromCli.mockImplementationOnce((_method, options) => {
      let watchdog: ReturnType<typeof setTimeout>;
      let response: ReturnType<typeof setTimeout>;
      return new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("gateway timeout")), Number(options.timeout));
        response = setTimeout(() => reject(diagnostic), requestTimeoutMs + 750);
      }).finally(() => {
        clearTimeout(watchdog);
        clearTimeout(response);
      });
    });
    try {
      const result = callBrowserRequest(
        { json: true, timeout: String(requestTimeoutMs) },
        { method: "GET", path: "/snapshot" },
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(800);
      expect(await result).toBe(diagnostic);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests the browser.request admin scope explicitly", async () => {
    await callBrowserRequest(
      { json: true },
      { method: "GET", path: "/status", query: { profile: "openclaw" } },
      { progress: true },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0];
    const extra = call?.[3];
    expect(extra).toEqual({ progress: true, scopes: ["operator.admin"] });
  });

  it("rejects partial parent timeout values before gateway dispatch", async () => {
    await expect(
      callBrowserRequest({ json: true, timeout: "60000ms" }, { method: "GET", path: "/status" }),
    ).rejects.toThrow("--timeout must be a positive integer.");
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("caps explicit request timeouts to Node's safe timer range", async () => {
    await callBrowserRequest(
      { json: true },
      { method: "GET", path: "/status" },
      { timeoutMs: 3_000_000_000 },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0];
    expect(call?.[1]).toMatchObject({ timeout: String(MAX_TIMER_TIMEOUT_MS) });
    expect(call?.[2]).toMatchObject({ timeoutMs: MAX_TIMER_TIMEOUT_MS - 10_000 });
  });

  it("caps parent timeout values to Node's safe timer range", async () => {
    await callBrowserRequest(
      { json: true, timeout: "3000000000" },
      { method: "GET", path: "/status" },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0];
    expect(call?.[1]).toMatchObject({ timeout: String(MAX_TIMER_TIMEOUT_MS) });
    expect(call?.[2]).toMatchObject({ timeoutMs: MAX_TIMER_TIMEOUT_MS - 10_000 });
  });

  it("accepts strict signed and zero-padded parent timeout values", async () => {
    await callBrowserRequest(
      { json: true, timeout: " +060000 " },
      { method: "GET", path: "/status" },
    );

    const call = gatewayMocks.callGatewayFromCli.mock.calls[0];
    expect(call?.[1]).toMatchObject({ timeout: "70000" });
    expect(call?.[2]).toMatchObject({ timeoutMs: 60_000 });
  });
});
