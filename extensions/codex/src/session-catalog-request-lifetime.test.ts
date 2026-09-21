import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as diagnosticRuntime from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./app-server/client.js";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { getCurrentSharedClientEntry } from "./app-server/shared-client-lifecycle.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { createCodexSessionCatalogNodeHostCommands } from "./session-catalog-listing.js";
import { CODEX_APP_SERVER_THREADS_LIST_COMMAND } from "./session-catalog-parsing.js";

type ListFrame = { id: number; params: CodexThreadListParams };
type CatalogResources = {
  transports: ReturnType<typeof createClientHarness>[];
  companion?: CodexAppServerClient;
  factories: ReturnType<typeof createCodexSessionCatalogControl>[];
};
const REQUEST_TIMEOUT_MS = 200;
const SLOW_DIAGNOSTIC_REQUEST_TIMEOUT_MS = 2_000;

function page(threadId: string) {
  return {
    data: [{ ...threadStartResult(threadId).thread, source: "cli" }],
    nextCursor: null,
  };
}

function observeHydration(pending: Promise<void>) {
  // Observe rejection immediately, including when a failing assertion enters cleanup first.
  void pending.catch(() => undefined);
  return pending;
}

async function createCatalogHarness(agentDir: string, resources: CatalogResources) {
  const { transports } = resources;
  const frames: Array<ListFrame & { transport: ReturnType<typeof createClientHarness> }> = [];
  const frameWaiters = new Map<
    number,
    ReturnType<typeof createDeferred<(typeof frames)[number]>>
  >();
  let closed = false;
  vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
    if (closed) {
      throw new Error("Catalog fixture is closed");
    }
    const transport = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as ListFrame & { method: string };
        if (message.method === "initialize") {
          send({ id: message.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
        } else if (message.method === "model/list") {
          send({ id: message.id, result: { data: [] } });
        } else if (message.method === "thread/list") {
          const frame = { ...message, transport };
          const index = frames.push(frame) - 1;
          frameWaiters.get(index)?.resolve(frame);
          frameWaiters.delete(index);
        } else if (message.method !== "initialized") {
          throw new Error(`Unexpected catalog fixture request: ${message.method}`);
        }
      },
    });
    transports.push(transport);
    return transport.client;
  });
  let config: OpenClawConfig = {
    agents: { list: ["main", "other"].map((id) => ({ id, agentDir, workspace: agentDir })) },
  };
  const pluginConfig = {
    appServer: {
      transport: "websocket",
      homeScope: "agent",
      url: "wss://catalog-lifetime.example.test",
      authToken: "synthetic-catalog-lifetime-token",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };
  let now = 1_000;
  const newFactory = (requestTimeoutMs = REQUEST_TIMEOUT_MS, state?: CodexCatalogState) => {
    const created = createCodexSessionCatalogControl({
      getPluginConfig: () => ({
        ...pluginConfig,
        appServer: { ...pluginConfig.appServer, requestTimeoutMs },
      }),
      getRuntimeConfig: () => config,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      now: () => now,
      env: {},
      ...(state ? { openResidentState: () => state } : {}),
    });
    resources.factories.push(created);
    return created;
  };
  const factory = newFactory();
  const control = factory.forRequest("main");
  const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig, env: {} });
  const companion = await getLeasedSharedCodexAppServerClient({
    agentDir,
    config,
    startOptions: runtime.start,
    authProfileId: null,
  });
  resources.companion = companion;
  await companion.request("model/list", {});
  const requests = vi.spyOn(companion, "request");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const clockStartedAt = Date.now();
  // Request delivery rechecks monotonic deadlines even when their timers have not run.
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockStartedAt);
  return {
    control,
    factory,
    companion,
    transports,
    frames,
    newFactory,
    createSlowDiagnosticsControl: () =>
      newFactory(SLOW_DIAGNOSTIC_REQUEST_TIMEOUT_MS).forRequest("main"),
    replaceConfig: () => {
      config = structuredClone(config);
    },
    advanceClock: () => {
      now += 32_001;
    },
    async frame(index: number) {
      const frame = frames[index];
      if (frame) {
        return frame;
      }
      assert(!closed, "Catalog fixture is closed");
      let waiter = frameWaiters.get(index);
      if (!waiter) {
        waiter = createDeferred<(typeof frames)[number]>();
        frameWaiters.set(index, waiter);
      }
      return await waiter.promise;
    },
    close() {
      closed = true;
      for (const [index, waiter] of frameWaiters) {
        waiter.reject(new Error(`Catalog fixture closed before request ${index}`));
      }
      frameWaiters.clear();
    },
    reply(frame: (typeof frames)[number], threadId: string) {
      frame.transport.send({ id: frame.id, result: page(threadId) });
    },
    async expireWaiter() {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await vi.waitFor(() => expect(getCurrentSharedClientEntry(companion)?.activeLeases).toBe(1), {
        interval: 1,
      });
    },
    requests,
  };
}

type CatalogLogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;
let diagnosticClock = 1_000_000;

async function withPageDiagnostics(
  run: (records: CatalogLogRecord[], advanceClock: (elapsedMs?: number) => void) => Promise<void>,
) {
  const records: CatalogLogRecord[] = [];
  diagnosticRuntime.resetDiagnosticEventsForTest();
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  setLoggerOverride({ level: "warn", consoleLevel: "silent" });
  diagnosticClock += 61_000;
  vi.spyOn(performance, "now").mockImplementation(() => diagnosticClock);
  const unsubscribe = diagnosticRuntime.onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record" && event.message === "slow Codex catalog page producer") {
      records.push(event);
    }
  });
  try {
    await run(records, (elapsedMs = 1_500) => {
      diagnosticClock += elapsedMs;
    });
  } finally {
    await diagnosticRuntime.waitForDiagnosticEventsDrained();
    unsubscribe();
    resetLogger();
    diagnosticRuntime.resetDiagnosticEventsForTest();
    vi.unstubAllEnvs();
  }
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("resident catalog hydration request lifetime", () => {
  let agentDir: string;
  let h: Awaited<ReturnType<typeof createCatalogHarness>>;
  let resources: CatalogResources;

  beforeEach(async () => {
    resources = { transports: [], factories: [] };
    agentDir = tempDirs.make("openclaw-catalog-lifetime-");
    h = await createCatalogHarness(agentDir, resources);
  });

  afterEach(async () => {
    h.close();
    const stopped = Promise.all(resources.factories.map((factory) => factory.stop()));
    void stopped.catch(() => undefined);
    try {
      if (resources.companion) {
        releaseLeasedSharedCodexAppServerClient(resources.companion);
      }
      const closed = await Promise.allSettled(
        resources.transports.map(({ client }) => client.closeAndWait()),
      );
      await stopped;
      expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("splits a successful control wait at the existing client request boundary", async () => {
    const control = h.createSlowDiagnosticsControl();
    await withPageDiagnostics(async (records, advanceClock) => {
      const pending = observeHydration(control.initialize());
      const frame = await h.frame(0);
      advanceClock();
      h.reply(frame, "timed-success");
      await expect(pending).resolves.toBeUndefined();
      await expect(control.listPage({ limit: 1 })).resolves.toMatchObject({
        sessions: [{ threadId: "timed-success" }],
      });
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        outcome: "resolved",
        controlRequestCalls: 1,
        inclusiveControlRequestWaitMs: 1_500,
        controlLoadMs: 0,
        controlPrepareMs: 0,
        controlAcquireClientMs: 0,
        controlClientRequestMs: 1_500,
        controlReleaseClientMs: 0,
      });
      expect(records[0]?.attributes).not.toHaveProperty("controlFailurePhase");
      expect(records[0]?.attributes).not.toHaveProperty("controlFailureCategory");
    });
  });

  it("attributes a rejected control request without exposing its private RPC error", async () => {
    const control = h.createSlowDiagnosticsControl();
    await withPageDiagnostics(async (records, advanceClock) => {
      const pending = observeHydration(control.initialize());
      const rejected = expect(pending).rejects.toMatchObject({
        code: -32601,
        message: "synthetic-private-control-error",
      });
      const frame = await h.frame(0);
      advanceClock();
      frame.transport.send({
        id: frame.id,
        error: { code: -32601, message: "synthetic-private-control-error" },
      });
      await rejected;
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(h.frames).toHaveLength(1);
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        outcome: "rejected",
        controlRequestCalls: 1,
        controlFailurePhase: "client-request",
        controlFailureCategory: "rpc-method-unavailable",
      });
      expect(JSON.stringify(records)).not.toContain("synthetic-private-control-error");
    });
  });

  it("shares cold hydration with a pinned caller and releases only the hydration lease", async () => {
    await h.control.withPinnedConnection(async (pinned) => {
      expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(2);
      const pending = observeHydration(pinned.initialize());
      const frame = await h.frame(0);
      const joined = observeHydration(h.control.initialize());
      expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(3);
      const listed = pinned.listPage({ limit: 10 });
      void listed.catch(() => undefined);
      h.reply(frame, "shared");
      await Promise.all([pending, joined]);
      expect((await listed).sessions).toMatchObject([{ threadId: "shared" }]);
      expect(h.frames).toHaveLength(1);
      expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(2);
      expect((await pinned.listPage({ limit: 10 })).sessions).toMatchObject([
        { threadId: "shared" },
      ]);
      expect(h.frames).toHaveLength(1);
    });
    expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(1);
    await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });
  });

  it.each(["agent", "query"] as const)(
    "shares one cold native request across a different %s in the same home",
    async (variation) => {
      const first = observeHydration(h.control.initialize());
      const frame = await h.frame(0);
      const control = variation === "agent" ? h.factory.forRequest("other") : h.control;
      const joined = observeHydration(control.initialize());
      const listed = control.listPage({ limit: 10 });
      void listed.catch(() => undefined);
      await nextTurn();
      expect(h.requests.mock.calls.filter(([method]) => method === "thread/list")).toHaveLength(1);
      h.reply(frame, "shared");
      await Promise.all([first, joined]);
      expect((await listed).sessions).toMatchObject([{ threadId: "shared" }]);
      expect((await control.listPage({ limit: 10 })).sessions).toMatchObject([
        { threadId: "shared" },
      ]);
      expect(h.frames).toHaveLength(1);
      expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(1);
    },
  );

  it("times out the shared initializer without closing its companion or reviving expired callers", async () => {
    const first = observeHydration(h.control.initialize());
    const expired = await h.frame(0);
    const joined = observeHydration(h.control.initialize());
    await h.expireWaiter();
    await expect(first).rejects.toThrow("thread/list timed out");
    await expect(joined).rejects.toThrow("thread/list timed out");
    await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });

    const current = observeHydration(h.control.initialize());
    const retry = await h.frame(1);
    expect(retry.transport.client).toBe(expired.transport.client);
    h.reply(expired, "late-expired");
    h.reply(retry, "current");
    await current;
    expect((await h.control.listPage({})).sessions).toMatchObject([{ threadId: "current" }]);
    await expect(first).rejects.toThrow("thread/list timed out");
    expect(h.frames).toHaveLength(2);
    expect(h.transports).toHaveLength(1);
    expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(1);
  });

  it("discards an unobserved late hydration response instead of publishing it", async () => {
    const first = observeHydration(h.control.initialize());
    const expired = await h.frame(0);
    await h.expireWaiter();
    await expect(first).rejects.toThrow("thread/list timed out");
    h.reply(expired, "unobserved");
    await nextTurn();

    const current = observeHydration(h.control.initialize());
    const retry = await h.frame(1);
    h.reply(retry, "current");
    await current;
    const result = await h.control.listPage({});
    expect(result.sessions).toMatchObject([{ threadId: "current" }]);
    await expect(h.control.listPage({})).resolves.toEqual(result);
    expect(h.frames).toHaveLength(2);
  });

  it("keeps a hydrated home usable after native timeouts would have expired", async () => {
    const pending = observeHydration(h.control.initialize());
    h.reply(await h.frame(0), "resident");
    await pending;
    const resident = await h.control.listPage({});
    h.advanceClock();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await expect(h.control.listPage({})).resolves.toEqual(resident);
    await expect(h.control.listPage({ limit: 10 })).resolves.toEqual(resident);
    expect(h.frames).toHaveLength(1);
    expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(1);
  });

  it.each(["config", "factory"] as const)(
    "keeps a replacement %s independent of an expired initializer on the same client",
    async (partition) => {
      const first = observeHydration(h.control.initialize());
      const expired = await h.frame(0);
      await h.expireWaiter();
      await expect(first).rejects.toThrow("thread/list timed out");
      let control = h.control;
      if (partition === "config") {
        h.replaceConfig();
      } else {
        control = h.newFactory().forRequest("main");
      }
      const current = observeHydration(control.initialize());
      const independent = await h.frame(1);
      expect(independent.transport.client).toBe(expired.transport.client);
      h.reply(independent, "replacement");
      await current;
      expect((await control.listPage({})).sessions).toMatchObject([{ threadId: "replacement" }]);
      h.reply(expired, "old-result");
      await expect(first).rejects.toThrow("thread/list timed out");
      expect(h.frames).toHaveLength(2);
    },
  );

  it("serves replacement configs independently while draining retired hydration at shutdown", async () => {
    const first = observeHydration(h.control.initialize());
    const retired = await h.frame(0);
    let retiredReplied = false;
    const replyRetired = () => {
      if (!retiredReplied) {
        retiredReplied = true;
        h.reply(retired, "retired-thread");
      }
    };
    try {
      for (let generation = 1; generation <= 2; generation++) {
        h.replaceConfig();
        const delivered = vi.fn();
        const listed = h.control.listPage({}).then((result) => {
          delivered(result);
          return result;
        });
        void listed.catch(() => undefined);
        // The replacement awaits its own first page, not the retired native request.
        await nextTurn();
        expect(delivered).not.toHaveBeenCalled();
        const current = observeHydration(h.control.initialize());
        h.reply(await h.frame(generation), `replacement-${generation}`);
        await current;
        expect((await listed).sessions).toMatchObject([{ threadId: `replacement-${generation}` }]);
        expect((await h.control.listPage({})).sessions).toMatchObject([
          { threadId: `replacement-${generation}` },
        ]);
      }
      const stopped = vi.fn();
      const stopping = h.factory.stop().then(stopped);
      await nextTurn();
      expect(stopped).not.toHaveBeenCalled();
      replyRetired();
      await expect(first).rejects.toThrow(/closed|configuration changed/);
      await stopping;
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      replyRetired();
      await first.catch(() => undefined);
    }
  });

  it("keeps node updates deferred through catalog persistence and disconnect before reconnecting", async () => {
    releaseLeasedSharedCodexAppServerClient(h.companion);
    resources.companion = undefined;
    const writeStarted = createDeferred<void>();
    const writeAllowed = createDeferred<void>();
    const values = new Map<string, StoredCodexCatalogEntry>();
    const state: CodexCatalogState = {
      entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
      register: async (key, value) => {
        if (value.kind === "row" && value.row.threadId === "retained-thread") {
          writeStarted.resolve();
          await writeAllowed.promise;
        }
        values.set(key, structuredClone(value));
      },
      delete: async (key) => values.delete(key),
    };
    const factory = h.newFactory(REQUEST_TIMEOUT_MS, state);
    const command = createCodexSessionCatalogNodeHostCommands(factory).find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND,
    );
    assert(command, "Expected the registered Codex node catalog command");
    expect(command.hasActiveWork?.()).toBe(false);
    const paramsJSON = JSON.stringify({ agentId: "main", limit: 1 });
    const listed = command.handle(paramsJSON);
    void listed.catch(() => undefined);
    try {
      h.reply(await h.frame(0), "retained-thread");
      await writeStarted.promise;
      expect(JSON.parse(await listed)).toMatchObject({
        sessions: [{ threadId: "retained-thread" }],
      });
      expect(command.hasActiveWork?.()).toBe(true);

      const disconnected = vi.fn();
      const disconnecting = Promise.resolve(command.onDisconnect?.()).then(disconnected);
      await nextTurn();
      expect(disconnected).not.toHaveBeenCalled();
      expect(command.hasActiveWork?.()).toBe(true);
      writeAllowed.resolve();
      await disconnecting;
      expect(command.hasActiveWork?.()).toBe(false);

      const reconnected = command.handle(paramsJSON);
      void reconnected.catch(() => undefined);
      h.reply(await h.frame(1), "reconnected-thread");
      expect(JSON.parse(await reconnected)).toMatchObject({
        sessions: [{ threadId: "reconnected-thread" }],
      });
      await command.onDisconnect?.();
      expect(command.hasActiveWork?.()).toBe(false);
    } finally {
      writeAllowed.resolve();
      await factory.stop();
    }
  });

  it.each([false, true])("bounds same-home retirement waits (expired: %s)", async (expired) => {
    const writeStarted = createDeferred<void>();
    const writeAllowed = createDeferred<void>();
    const values = new Map<string, StoredCodexCatalogEntry>();
    const state: CodexCatalogState = {
      entries: vi.fn(async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 }))),
      register: async (key, value) => {
        if (value.kind === "row" && value.row.threadId === "retired-prefix") {
          writeStarted.resolve();
          await writeAllowed.promise;
        }
        values.set(key, structuredClone(value));
      },
      delete: async (key) => values.delete(key),
    };
    const control = h.newFactory(REQUEST_TIMEOUT_MS, state).forRequest("main");
    const first = observeHydration(control.initialize());
    const prefix = await h.frame(0);
    prefix.transport.send({
      id: prefix.id,
      result: { ...page("retired-prefix"), nextCursor: "old-tail" },
    });
    await writeStarted.promise;
    const retired = await h.frame(1);
    let retiredReplied = false;
    try {
      h.replaceConfig();
      const delivered = vi.fn();
      const listed = control.listPage({}).then((result) => {
        delivered(result);
        return result;
      });
      const rejected = vi.fn();
      void listed.catch(rejected);
      await nextTurn();
      expect(delivered).not.toHaveBeenCalled();
      expect(state.entries).toHaveBeenCalledOnce();
      if (expired) {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({ code: "APP_SERVER_UNAVAILABLE" }),
        );
        expect(state.entries).toHaveBeenCalledOnce();
      }
      writeAllowed.resolve();
      await nextTurn();
      expect(delivered).not.toHaveBeenCalled();
      const current = observeHydration(control.initialize());
      h.reply(await h.frame(2), "current-thread");
      await current;
      if (expired) {
        expect(delivered).not.toHaveBeenCalled();
      } else {
        expect((await listed).sessions).toMatchObject([{ threadId: "current-thread" }]);
      }
      const beforeRetiredReply = await state.entries();
      expect(
        beforeRetiredReply.flatMap(({ value }) =>
          value.kind === "row" ? [value.row.threadId] : [],
        ),
      ).toEqual(["current-thread"]);
      h.reply(retired, "stale-thread");
      retiredReplied = true;
      await expect(first).rejects.toThrow(
        expired ? /thread\/list timed out/ : /closed|configuration changed/,
      );
      expect(await state.entries()).toEqual(beforeRetiredReply);
      expect((await control.listPage({})).sessions).toMatchObject([{ threadId: "current-thread" }]);
    } finally {
      writeAllowed.resolve();
      if (!retiredReplied) {
        h.reply(retired, "stale-thread");
      }
      await first.catch(() => undefined);
    }
  });

  it("reconnects cold hydration after the old connection closes", async () => {
    const first = observeHydration(h.control.initialize());
    const old = await h.frame(0);
    old.transport.emitExit();
    await expect(first).rejects.toThrow();

    const current = observeHydration(h.control.initialize());
    const replacement = await h.frame(1);
    expect(replacement.transport.client).not.toBe(old.transport.client);
    h.reply(replacement, "reconnected");
    await current;
    expect((await h.control.listPage({})).sessions).toMatchObject([{ threadId: "reconnected" }]);
    expect(h.frames).toHaveLength(2);
    expect(h.transports).toHaveLength(2);
  });
});
