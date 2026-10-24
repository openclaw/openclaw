import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createMockIncomingRequest, createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";

const emptyWebhook = () => ({ ok: true, result: { url: "" } });
const pendingPoll = () => new Promise<never>(() => {});
const getWebhookInfoMock = vi.fn(async () => emptyWebhook());
const deleteWebhookMock = vi.fn(async () => emptyWebhook());
const getUpdatesMock = vi.fn<(typeof import("./api.js"))["getUpdates"]>(pendingPoll);
const setWebhookMock = vi.fn(async () => emptyWebhook());
const getZaloRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    deleteWebhook: deleteWebhookMock,
    getWebhookInfo: getWebhookInfoMock,
    getUpdates: getUpdatesMock,
    setWebhook: setWebhookMock,
  };
});

vi.mock("./runtime.js", () => ({
  getZaloRuntime: getZaloRuntimeMock,
}));

const TEST_ACCOUNT = { accountId: "default", config: {} } as unknown as ResolvedZaloAccount;

const READY_STATUS = {
  running: true,
  connected: true,
  lifecycle: "ready",
  terminalDisconnect: undefined,
  lastConnectedAt: expect.any(Number),
  lastError: null,
};
const recovering = (lastError: unknown) => ({
  connected: false,
  lifecycle: "recovering",
  lastError,
});
let testStateDir: string | undefined;

async function settleLifecycleWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await immediate();
  }
}

async function startLifecycleMonitor(
  options: {
    statusSink?: (patch: Record<string, unknown>) => void;
    useWebhook?: boolean;
    webhookSecret?: string;
    webhookUrl?: string;
  } = {},
) {
  const { monitorZaloProvider } = await import("./monitor.js");
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const completion = { settled: false };
  const run = monitorZaloProvider({
    token: "test-token",
    account: TEST_ACCOUNT,
    config: {},
    runtime,
    abortSignal: abort.signal,
    ...options,
  }).then(() => {
    completion.settled = true;
  });
  return { abort, runtime, run, completion };
}

describe("monitorZaloProvider lifecycle", () => {
  beforeEach(async () => {
    const createdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalo-monitor-"));
    testStateDir = await fs.realpath(createdDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", testStateDir);
    const core = createPluginRuntimeMock();
    core.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("zalo", options);
    core.state.openChannelIngressQueue = (<T>(options: { accountId?: string }) =>
      createChannelIngressQueueForTests<T>({
        channelId: "zalo",
        accountId: options.accountId ?? "default",
        stateDir: testStateDir,
      })) as PluginRuntime["state"]["openChannelIngressQueue"];
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    getUpdatesMock.mockReset();
    getUpdatesMock.mockImplementation(pendingPoll);
    setActivePluginRegistry(createEmptyPluginRegistry());
    // Agent close releases leases through shared state; closing shared state first
    // can reopen it during teardown and leave Windows handles under the state dir.
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (testStateDir) {
      await fs.rm(testStateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      testStateDir = undefined;
    }
    vi.unstubAllEnvs();
  });

  it("cancels the pending polling request when the monitor stops", async () => {
    const actualApi = await vi.importActual<typeof import("./api.js")>("./api.js");
    const started = Promise.withResolvers<AbortSignal>();
    const request = Promise.withResolvers<Response>();
    getUpdatesMock.mockImplementationOnce((...args: Parameters<typeof actualApi.getUpdates>) =>
      actualApi.getUpdates(args[0], args[1], async (_url, init) => {
        const signal = expectDefined(init?.signal, "Polling request cancellation signal");
        started.resolve(signal);
        signal.addEventListener(
          "abort",
          () => request.reject(new DOMException("Polling request aborted", "AbortError")),
          { once: true },
        );
        return request.promise;
      }),
    );
    const { abort, run } = await startLifecycleMonitor();
    try {
      const requestSignal = await started.promise;
      abort.abort();
      await run;
      expect(requestSignal.aborted).toBe(true);
    } finally {
      abort.abort();
      request.resolve(new Response(JSON.stringify({ ok: true })));
      await run;
    }
  });

  it("clears poll error backoff on abort without retrying", async () => {
    vi.useFakeTimers();
    let monitor: Awaited<ReturnType<typeof startLifecycleMonitor>> | undefined;
    try {
      getUpdatesMock.mockReset();
      getUpdatesMock.mockRejectedValue(new Error("zalo poll transport failed"));
      const statusSink = vi.fn();

      monitor = await startLifecycleMonitor({ statusSink });
      const { abort, run, runtime } = monitor;

      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("zalo poll transport failed"),
      );
      expect(statusSink).toHaveBeenCalledWith(
        recovering(expect.stringContaining("zalo poll transport failed")),
      );
      expect(getUpdatesMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      abort.abort();
      await run;

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getUpdatesMock).toHaveBeenCalledTimes(1);
      expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=polling");
    } finally {
      monitor?.abort.abort();
      await monitor?.run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it.each([
    ["no webhook", ""],
    ["ready", ""],
    ["existing webhook", "[default] Zalo polling mode ready (webhook disabled)"],
    [
      "404",
      "[default] Zalo polling mode webhook inspection unavailable; continuing without webhook cleanup",
    ],
  ])("starts polling after %s inspection", async (inspection, log) => {
    const { ZaloApiError } = await import("./api.js");
    if (inspection === "404") {
      getWebhookInfoMock.mockRejectedValueOnce(new ZaloApiError("Not Found", 404, "Not Found"));
    } else if (inspection === "existing webhook") {
      getWebhookInfoMock.mockResolvedValueOnce({
        ok: true,
        result: { url: "https://example.com/hooks/zalo" },
      });
    }
    const ready = inspection === "ready";
    if (ready) {
      getUpdatesMock.mockResolvedValueOnce({ ok: true, result: undefined });
    }
    const statusSink = vi.fn();
    const { abort, runtime, run, completion } = await startLifecycleMonitor({ statusSink });
    if (ready) {
      await vi.waitFor(() => expect(statusSink).toHaveBeenCalledWith(READY_STATUS));
    } else {
      await settleLifecycleWork();
    }
    if (!ready) {
      expect(getUpdatesMock).toHaveBeenCalledTimes(1);
    }
    expect(getWebhookInfoMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledTimes(inspection === "existing webhook" ? 1 : 0);
    if (log) {
      expect(runtime.log).toHaveBeenCalledWith(log);
    }
    if (inspection === "404") {
      expect(runtime.error).not.toHaveBeenCalled();
    }
    expect(completion.settled).toBe(false);
    abort.abort();
    await run;
    expect(completion.settled).toBe(true);
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=polling");
  });

  it("preserves registered HTTP responses and waits for webhook deletion on shutdown", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const setWebhookCalled = Promise.withResolvers<void>();
    setWebhookMock.mockImplementationOnce(async () => {
      expect(registry.httpRoutes).toHaveLength(2);
      setWebhookCalled.resolve();
      return emptyWebhook();
    });

    const deleteWebhookCalled = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<Awaited<ReturnType<typeof deleteWebhookMock>>>();
    deleteWebhookMock.mockImplementationOnce(() => {
      deleteWebhookCalled.resolve();
      return deleted.promise;
    });

    const statusSink = vi.fn();
    const { abort, runtime, run, completion } = await startLifecycleMonitor({
      statusSink,
      useWebhook: true,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });

    await setWebhookCalled.promise;
    await settleLifecycleWork();
    expect(statusSink).toHaveBeenCalledWith(READY_STATUS);
    await settleLifecycleWork();
    expect(setWebhookMock).toHaveBeenCalledTimes(1);
    expect(registry.httpRoutes).toHaveLength(2);

    for (const [source, handledPath, handledStatus, handledBody] of [
      ["zalo-hosted-media", "/hooks/zalo/media/invalid", 404, "Not Found"],
      ["zalo-webhook", "/hooks/zalo", 405, "Method Not Allowed"],
    ] as const) {
      const route = expectDefined(
        registry.httpRoutes.find((entry) => entry.source === source),
        source,
      );
      for (const started of [false, true]) {
        const req = createMockIncomingRequest([]);
        req.method = "POST";
        req.url = "/unmatched";
        const res = createMockServerResponse();
        if (started) {
          res.statusCode = 202;
          res.setHeader("Content-Type", "text/plain");
          res.end("Already handled");
        }
        await route.handler(req, res);
        expect(res.statusCode).toBe(started ? 202 : 404);
        expect(res.getHeader("Content-Type")).toBe(
          started ? "text/plain" : "text/plain; charset=utf-8",
        );
        expect(res.body).toBe(started ? "Already handled" : "Not Found");
      }
      const req = createMockIncomingRequest([]);
      req.method = "GET";
      req.url = handledPath;
      const res = createMockServerResponse();
      await route.handler(req, res);
      expect(res.statusCode).toBe(handledStatus);
      expect(res.getHeader("Content-Type")).toBeUndefined();
      expect(res.body).toBe(handledBody);
    }

    abort.abort();

    await deleteWebhookCalled.promise;
    expect(deleteWebhookMock).toHaveBeenCalledTimes(1);
    expect(deleteWebhookMock).toHaveBeenCalledWith("test-token", undefined, 5000);
    expect(completion.settled).toBe(false);
    expect(registry.httpRoutes).toHaveLength(2);

    deleted.resolve(emptyWebhook());
    await run;

    expect(completion.settled).toBe(true);
    expect(registry.httpRoutes).toHaveLength(0);
    expect(runtime.log).toHaveBeenCalledWith("[default] Zalo provider stopped mode=webhook");
  });

  it.each([true, false])("rejects foreign route ownership (webhook=%s)", async (useWebhook) => {
    const registry = createEmptyPluginRegistry();
    const existingRoute = {
      path: useWebhook ? "/hooks/zalo" : "/hooks/zalo/media",
      match: useWebhook ? ("exact" as const) : ("prefix" as const),
      auth: "plugin" as const,
      handler: () => {},
      pluginId: "other-plugin",
      source: useWebhook ? "other-webhook" : "other-media",
    };
    registry.httpRoutes.push(existingRoute);
    setActivePluginRegistry(registry);
    const statusSink = vi.fn();

    const { runtime, run } = await startLifecycleMonitor({
      statusSink,
      useWebhook,
      webhookUrl: "https://example.com/hooks/zalo",
      webhookSecret: "supersecret", // pragma: allowlist secret
    });

    const error = useWebhook ? "route replacement denied" : "route reuse denied";
    await expect(run).rejects.toThrow(error);

    expect(setWebhookMock).not.toHaveBeenCalled();
    if (!useWebhook) {
      expect(getWebhookInfoMock).not.toHaveBeenCalled();
      expect(getUpdatesMock).not.toHaveBeenCalled();
    }
    expect(registry.httpRoutes).toEqual([existingRoute]);
    expect(statusSink).toHaveBeenCalledWith(recovering(expect.stringContaining(error)));
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
    if (useWebhook) {
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    }
    expect(runtime.log).toHaveBeenCalledWith(
      `[default] Zalo provider stopped mode=${useWebhook ? "webhook" : "polling"}`,
    );
  });
});
