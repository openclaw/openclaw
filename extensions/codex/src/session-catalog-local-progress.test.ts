import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { observe } from "./session-catalog-list-operation.test-support.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  idleThread,
  registerCodexSessionCatalog,
} from "./session-catalog.test-helpers.js";

beforeAll(async () => {
  // Keep paired-node module loading outside the local-page fake-timer measurement.
  await import("./session-catalog-node-continue.js");
});

afterEach(() => vi.useRealTimers());

function fixture() {
  const { runtime } = createRuntime();
  const { api, getProvider } = createGatewayApi(runtime, config);
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  registerCodexSessionCatalog({
    api,
    control,
    bindingStore: createCodexTestBindingStore(),
    getRuntimeConfig: () => config,
  });
  const started = createDeferred<void>();
  const response = createDeferred<unknown>();
  commandRpcMocks.codexControlRequest.mockImplementation(() => {
    started.resolve();
    return response.promise;
  });
  const onHost = vi.fn();
  const controller = new AbortController();
  const publications: Promise<void>[] = [];
  const list = (allowPartialResults = true) =>
    getProvider()!.list({
      agentId: "main",
      limitPerHost: 1,
      allowPartialResults,
      signal: controller.signal,
      onHost,
      waitUntil: (completion) => publications.push(completion),
    });
  const reply = () =>
    response.resolve({
      data: [idleThread({ id: "cold-row", source: "cli", originator: "codex_cli_rs" })],
      nextCursor: null,
    });
  return { started, response, reply, list, onHost, publications, controller };
}

it.each([true, false])(
  "bounds cold local progress and reuses resident rows (partial: %s)",
  async (partial) => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const result = observe(f.list(partial));
    try {
      await f.started.promise;
      await vi.advanceTimersByTimeAsync(250);
      expect.soft(result.state.settled).toBe(partial);
      expect(f.onHost).not.toHaveBeenCalled();
      if (result.state.settled) {
        await expect(result.done).resolves.toMatchObject({
          status: "fulfilled",
          value: [{ hostId: "gateway:local", connected: true, pending: true, sessions: [] }],
        });
      }
      await vi.advanceTimersByTimeAsync(1_750);
      f.reply();
      await result.done;
      await Promise.all(f.publications);
      expect(f.onHost).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessions: [expect.objectContaining({ threadId: "cold-row" })] }),
      );
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      commandRpcMocks.codexControlRequest.mockClear();
      await expect(f.list()).resolves.toMatchObject([
        { sessions: [{ threadId: "cold-row" }], connected: true },
      ]);
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    } finally {
      f.reply();
      await result.done;
      await Promise.allSettled(f.publications);
    }
  },
);

it.each(["error", "abort"])("settles a pending local publication after %s", async (outcome) => {
  const f = fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const result = observe(f.list());
  try {
    await f.started.promise;
    await vi.advanceTimersByTimeAsync(250);
    expect(result.state.settled).toBe(true);
    await expect(result.done).resolves.toMatchObject({
      status: "fulfilled",
      value: [{ pending: true }],
    });
    const error = new Error("catalog interrupted");
    if (outcome === "abort") {
      f.controller.abort(error);
      f.reply();
    } else {
      f.response.reject(error);
    }
    await Promise.all(f.publications);
    expect(f.onHost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        connected: false,
        sessions: [],
        error: {
          code: "APP_SERVER_UNAVAILABLE",
          message: "Codex app-server is unavailable on this host",
        },
      }),
    );
  } finally {
    f.reply();
    await result.done;
    await Promise.allSettled(f.publications);
  }
});

it.runIf(process.env.OPENCLAW_CATALOG_LOCAL_BENCH === "1")(
  "measures a two-second local app-server page",
  async () => {
    const f = fixture();
    const started = performance.now();
    const result = f.list();
    await f.started.promise;
    const timer = setTimeout(f.reply, 2_000);
    try {
      const hosts = await result;
      const coldMs = performance.now() - started;
      const coldRequests = commandRpcMocks.codexControlRequest.mock.calls.length;
      await Promise.all(f.publications);
      commandRpcMocks.codexControlRequest.mockClear();
      const warmStarted = performance.now();
      await f.list();
      console.info(
        "local catalog benchmark",
        JSON.stringify({
          coldMs,
          warmMs: performance.now() - warmStarted,
          pending: hosts[0]?.pending === true,
          coldRequests,
          warmRequests: commandRpcMocks.codexControlRequest.mock.calls.length,
        }),
      );
    } finally {
      clearTimeout(timer);
      f.reply();
      await result;
      await Promise.allSettled(f.publications);
    }
  },
);
