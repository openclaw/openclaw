import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn<typeof callGatewayFromCli>(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const { callBrowserRequest, runBrowserCliRequest } = await import("./browser-cli-shared.js");
const gateway = gatewayMocks.callGatewayFromCli;
const request = (timeout?: string) =>
  callBrowserRequest({ json: true, timeout }, { method: "GET", path: "/status" });

describe("callBrowserRequest", () => {
  beforeEach(() => {
    gateway.mockClear();
  });

  it("receives the browser timeout diagnostic before its Gateway transport watchdog", async () => {
    vi.useFakeTimers();
    const requestTimeoutMs = 50;
    const diagnostic = new Error("browser proxy timed out for GET /snapshot after 50ms");
    gateway.mockImplementationOnce((_method, options) => {
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

  it("rejects partial parent timeout values before gateway dispatch", async () => {
    await expect(request("60000ms")).rejects.toThrow("--timeout must be a positive integer.");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("caps parent timeout values to Node's safe timer range", async () => {
    await request("3000000000");
    const call = gateway.mock.calls[0];
    expect(call?.[1]).toMatchObject({ timeout: String(MAX_TIMER_TIMEOUT_MS) });
    expect(call?.[2]).toMatchObject({ timeoutMs: MAX_TIMER_TIMEOUT_MS - 130_000 });
    expect(call?.[3]).toEqual({ scopes: ["operator.admin"] });
  });
});

describe("runBrowserCliRequest", () => {
  const argv = process.argv;
  const run = (json: boolean, errorPolicy: "inline" | "runtime" = "inline") => {
    process.argv = `node openclaw browser ${json ? "--json " : ""}resize 640 480`.split(" ");
    return runBrowserCliRequest({ parent: { json }, path: "/resize", errorPolicy });
  };

  beforeEach(() => {
    gateway.mockReset().mockResolvedValue({ ok: true });
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new Error(`test exit:${code}`);
    });
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it.each(["inline", "runtime"] as const)(
    "propagates %s JSON failures to the host",
    async (errorPolicy) => {
      const failure = new Error("Request refused");
      gateway.mockRejectedValueOnce(failure);
      await expect(run(true, errorPolicy)).rejects.toBe(failure);
      expect(defaultRuntime.error).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it("retains local human diagnostics for inline requests", async () => {
    gateway.mockRejectedValueOnce(new Error("Request refused"));
    await expect(run(false)).rejects.toThrow("test exit:1");
    expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("Error: Request refused");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("retains successful inline JSON payloads", async () => {
    const payload = { ok: true };
    gateway.mockResolvedValueOnce(payload);
    await run(true);
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(payload);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});
