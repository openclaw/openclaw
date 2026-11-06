import { AsyncWorkScope, createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn<typeof callGatewayFromCli>(async () => ({ ok: true })),
}));
// mock-isolation: Exercise request policy without opening a real Gateway transport.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => gatewayMocks);
const { callBrowserRequest, runBrowserCliRequest } = await import("./browser-cli-shared.js");
const gateway = gatewayMocks.callGatewayFromCli;
const request = (timeout?: string) =>
  callBrowserRequest({ json: true, timeout }, { method: "GET", path: "/status" });
const argv = process.argv;
const run = (json: boolean) => {
  process.argv = `node openclaw browser ${json ? "--json " : ""}resize 640 480`.split(" ");
  return runBrowserCliRequest({ parent: { json }, path: "/resize", errorPolicy: "inline" });
};

beforeEach(() => {
  gateway.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`test exit:${code}`);
  });
});
afterEach(() => {
  process.argv = argv;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("receives the browser timeout diagnostic before its Gateway transport watchdog", async () => {
  vi.useFakeTimers();
  const diagnostic = new Error("browser proxy timed out for GET /status after 50ms");
  gateway.mockImplementationOnce((_method, options) => {
    let watchdog: ReturnType<typeof setTimeout>;
    let response: ReturnType<typeof setTimeout>;
    return new Promise<never>((_resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error("gateway timeout")), Number(options.timeout));
      response = setTimeout(() => reject(diagnostic), 800);
    }).finally(() => {
      clearTimeout(watchdog);
      clearTimeout(response);
    });
  });
  const result = request("50").catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(800);
  expect(await result).toBe(diagnostic);
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

it("propagates inline JSON failures to the host", async () => {
  const failure = new Error("Request refused");
  gateway.mockRejectedValueOnce(failure);
  await expect(run(true)).rejects.toBe(failure);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
});

it("retains local human diagnostics for inline requests", async () => {
  gateway.mockRejectedValueOnce(new Error("Request refused"));
  await expect(run(false)).rejects.toThrow("test exit:1");
  expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("Error: Request refused");
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});
it.each([
  ...[true, false].flatMap((json) =>
    (["before", "pending", "success", "error"] as const).map((stage) => ({
      json,
      stage,
      path: "/tabs",
      query: undefined,
    })),
  ),
  ...[
    { path: "/errors", query: { clear: false } },
    { path: "/requests", query: { clear: "false" } },
    { path: "/snapshot", query: { labels: false } },
  ].map(({ path, query }) => ({ path, query, json: true, stage: "pending" as const })),
])(
  "does not publish cancelled GET results ($json, $stage, $path)",
  async ({ json, stage, path, query }) => {
    const scope = new AsyncWorkScope();
    const started = createDeferred();
    const response = createDeferred<{ ok: boolean }>();
    let transportCancelled = false;
    gateway.mockImplementationOnce(async (_method, _options, _params, extra) => {
      started.resolve();
      extra?.signal?.addEventListener("abort", () => {
        transportCancelled = true;
        if (stage === "pending") {
          response.reject(new Error("Gateway request cancelled"));
        }
      });
      return await response.promise;
    });
    if (stage === "before") {
      scope.beginClose();
      response.resolve({ ok: true });
    }
    const pending = scope.run(() =>
      runBrowserCliRequest({
        parent: { json },
        method: "GET",
        path,
        query,
        errorPolicy: "inline",
        print: (result) => defaultRuntime.log(JSON.stringify(result)),
      }),
    );
    if (stage !== "before") {
      await started.promise;
      scope.beginClose();
      if (stage === "error") {
        response.reject(new Error("Late Gateway failure"));
      } else {
        response.resolve({ ok: true });
      }
    }
    await expect(pending).resolves.toBeUndefined();
    if (stage === "before") {
      expect(gateway).not.toHaveBeenCalled();
    } else if (stage === "pending") {
      expect(transportCancelled).toBe(true);
    }
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  },
);

it.each([
  { method: "POST" as const, path: "/tabs/synthetic", query: undefined },
  { method: "DELETE" as const, path: "/tabs/synthetic", query: undefined },
  { method: "GET" as const, path: "/errors", query: { clear: true } },
  { method: "GET" as const, path: "/requests", query: { clear: "true" } },
  { method: "GET" as const, path: "/snapshot", query: { labels: true } },
  { method: "GET" as const, path: "snapshot/", query: { labels: " YES " } },
  { method: "GET" as const, path: "/errors", query: { clear: 1 } },
])(
  "retains accepted $method $path receipts after interruption",
  async ({ method, path, query }) => {
    const scope = new AsyncWorkScope();
    const started = createDeferred();
    const response = createDeferred<{ ok: boolean }>();
    gateway.mockImplementationOnce(async () => {
      started.resolve();
      return await response.promise;
    });
    const pending = scope.run(() =>
      runBrowserCliRequest({ parent: { json: true }, method, path, query }),
    );
    await started.promise;
    scope.beginClose();
    response.resolve({ ok: true });
    await pending;
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ ok: true });
  },
);
