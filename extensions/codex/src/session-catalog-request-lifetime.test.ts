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
import type { CodexPluginConfig } from "./app-server/config.js";
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
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";

type ListFrame = { id: number };
const REQUEST_TIMEOUT_MS = 200;

function observe<T>(pending: Promise<T>) {
  // Observe rejection immediately, including when a failing assertion enters cleanup first.
  void pending.catch(() => undefined);
  return pending;
}
const expectPage = async (pending: Promise<CodexSessionCatalogPage>, threadId: string) => {
  await expect(pending).resolves.toMatchObject({ sessions: [{ threadId }] });
};

async function createCatalogHarness(agentDir: string) {
  const transports: ReturnType<typeof createClientHarness>[] = [];
  const factories: ReturnType<typeof createCodexSessionCatalogControl>[] = [];
  const frames: Array<ListFrame & { transport: ReturnType<typeof createClientHarness> }> = [];
  let frameReady = createDeferred<void>();
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
          frames.push({ ...message, transport });
          frameReady.resolve();
          frameReady = createDeferred<void>();
        } else if (message.method !== "initialized") {
          throw new Error(`Unexpected catalog fixture request: ${message.method}`);
        }
      },
    });
    transports.push(transport);
    return transport.client;
  });
  let config: OpenClawConfig = {
    agents: {
      entries: {
        main: { agentDir, workspace: agentDir },
        other: { agentDir, workspace: agentDir },
      },
    },
  };
  const pluginConfig = {
    appServer: {
      transport: "websocket",
      homeScope: "agent",
      url: "wss://catalog-lifetime.example.test",
      authToken: "synthetic-catalog-lifetime-token",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  } satisfies CodexPluginConfig;
  let now = 1_000;
  const newFactory = (requestTimeoutMs = REQUEST_TIMEOUT_MS, state?: CodexCatalogState) => {
    const created = createCodexSessionCatalogControl({
      getPluginConfig: () => ({
        appServer: { ...pluginConfig.appServer, requestTimeoutMs },
      }),
      getRuntimeConfig: () => config,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      now: () => now,
      env: {},
      ...(state ? { openResidentState: () => state } : {}),
    });
    factories.push(created);
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
  let companionLeased = true;
  const releaseCompanion = () => {
    if (companionLeased) {
      releaseLeasedSharedCodexAppServerClient(companion);
      companionLeased = false;
    }
  };
  await companion.request("model/list", {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const clockStartedAt = Date.now();
  // Request delivery rechecks monotonic deadlines even when their timers have not run.
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - clockStartedAt);
  return {
    control,
    factory,
    companion,
    get work() {
      return {
        frames: frames.length,
        transports: transports.length,
        leases: getCurrentSharedClientEntry(companion)?.activeLeases,
      };
    },
    newFactory,
    releaseCompanion,
    replaceConfig: () => {
      config = structuredClone(config);
    },
    advanceClock: () => {
      now += 32_001;
    },
    async frame(index: number) {
      for (;;) {
        const frame = frames[index];
        if (frame) {
          return frame;
        }
        assert(!closed, "Catalog fixture is closed");
        await frameReady.promise;
      }
    },
    async close() {
      closed = true;
      frameReady.resolve();
      const stopped = observe(Promise.all(factories.map((created) => created.stop())));
      try {
        releaseCompanion();
        const results = await Promise.allSettled(
          transports.map(({ client }) => client.closeAndWait()),
        );
        await stopped;
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    },
    reply(frame: (typeof frames)[number], threadId: string) {
      frame.transport.send({
        id: frame.id,
        result: {
          data: [{ ...threadStartResult(threadId).thread, source: "cli" }],
          nextCursor: null,
        },
      });
    },
    async expireWaiter() {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await vi.waitFor(() => expect(getCurrentSharedClientEntry(companion)?.activeLeases).toBe(1), {
        interval: 1,
      });
    },
  };
}

function blockedState(threadId: string) {
  const started = createDeferred<void>();
  const allowed = createDeferred<void>();
  const values = new Map<string, StoredCodexCatalogEntry>();
  const state: CodexCatalogState = {
    entries: vi.fn(async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 }))),
    register: async (key, value) => {
      if (value.kind === "row" && value.row.threadId === threadId) {
        started.resolve();
        await allowed.promise;
      }
      values.set(key, structuredClone(value));
    },
    delete: async (key) => values.delete(key),
  };
  return { state, writeStarted: started, writeAllowed: allowed };
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
  let h: Awaited<ReturnType<typeof createCatalogHarness>>;

  beforeEach(async () => {
    h = await createCatalogHarness(tempDirs.make("openclaw-catalog-lifetime-"));
  });

  afterEach(async () => h.close());

  it("attributes and redacts actual-client control failures", async () => {
    const control = h.newFactory(2_000).forRequest("main");
    await withPageDiagnostics(async (records, advanceClock) => {
      const pending = observe(control.initialize());
      const error = { code: -32601, message: "synthetic-private-control-error" };
      const settled = expect(pending).rejects.toMatchObject(error);
      const frame = await h.frame(0);
      advanceClock();
      frame.transport.send({ id: frame.id, error });
      await settled;
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        outcome: "rejected",
        controlRequestCalls: 1,
        controlFailurePhase: "client-request",
        controlFailureCategory: "rpc-method-unavailable",
      });
      expect(JSON.stringify(records)).not.toContain(error.message);
    });
  });

  it("shares same-home hydration across agents and releases only the hydration lease", async () => {
    await h.control.withPinnedConnection(async (pinned) => {
      expect(h.work.leases).toBe(2);
      const pending = observe(pinned.initialize());
      const frame = await h.frame(0);
      const joined = observe(h.factory.forRequest("other").initialize());
      await nextTurn();
      expect(h.work).toMatchObject({ frames: 1, leases: 3 });
      const listed = observe(pinned.listPage({ limit: 10 }));
      h.reply(frame, "shared");
      await Promise.all([pending, joined]);
      await expectPage(listed, "shared");
      expect(h.work).toMatchObject({ frames: 1, leases: 2 });
      await expectPage(pinned.listPage({ limit: 10 }), "shared");
    });
    expect(h.work.leases).toBe(1);
    await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });
  });

  it.each([false, true])(
    "expires shared callers without reviving them on retry (replacement factory=%s)",
    async (replace) => {
      const first = observe(h.control.initialize());
      const expired = await h.frame(0);
      const joined = observe(h.control.initialize());
      await h.expireWaiter();
      await expect(first).rejects.toThrow("thread/list timed out");
      await expect(joined).rejects.toThrow("thread/list timed out");
      await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });

      const control = replace ? h.newFactory().forRequest("main") : h.control;
      const current = observe(control.initialize());
      const retry = await h.frame(1);
      expect(retry.transport.client).toBe(expired.transport.client);
      if (!replace) {
        h.reply(expired, "late-expired");
      }
      h.reply(retry, "current");
      await current;
      await expectPage(control.listPage({}), "current");
      if (replace) {
        h.reply(expired, "late-expired");
      }
      await expect(first).rejects.toThrow("thread/list timed out");
      expect(h.work).toEqual({ frames: 2, transports: 1, leases: 1 });
    },
  );

  it("bounds cold list waits without aborting shared hydration or expiring resident pages", async () => {
    const factory = h.newFactory(60_000);
    const control = factory.forRequest("main");
    const hydration = observe(control.initialize());
    const frame = await h.frame(0);
    const delivered = vi.fn();
    const rejected = vi.fn();
    const listed = control.listPage({}).then(delivered, rejected);
    await nextTurn();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(delivered).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ code: "APP_SERVER_UNAVAILABLE" }),
    );
    expect(delivered).not.toHaveBeenCalled();
    expect(factory.hasActiveWork()).toBe(true);
    expect(h.work.leases).toBe(2);

    await vi.advanceTimersByTimeAsync(15_000);
    h.reply(frame, "resident");
    await hydration;
    await listed;
    const resident = await control.listPage({});
    expect(resident.sessions).toMatchObject([{ threadId: "resident" }]);
    h.advanceClock();
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(control.listPage({})).resolves.toEqual(resident);
    await expect(control.listPage({ limit: 10 })).resolves.toEqual(resident);
    expect(h.work).toMatchObject({ frames: 1, leases: 1 });
  });

  it("serves replacement configs independently while draining retired hydration at shutdown", async () => {
    const first = observe(h.control.initialize());
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
        const listed = observe(
          h.control.listPage({}).then((result) => {
            delivered(result);
            return result;
          }),
        );
        // The replacement awaits its own first page, not the retired native request.
        await nextTurn();
        expect(delivered).not.toHaveBeenCalled();
        const current = observe(h.control.initialize());
        h.reply(await h.frame(generation), `replacement-${generation}`);
        await current;
        await expectPage(listed, `replacement-${generation}`);
        await expectPage(h.control.listPage({}), `replacement-${generation}`);
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
    h.releaseCompanion();
    const { state, writeStarted, writeAllowed } = blockedState("retained-thread");
    const factory = h.newFactory(REQUEST_TIMEOUT_MS, state);
    const command = createCodexSessionCatalogNodeHostCommands(factory).find(
      (candidate) => candidate.command === CODEX_APP_SERVER_THREADS_LIST_COMMAND,
    );
    assert(command, "Expected the registered Codex node catalog command");
    expect(command.hasActiveWork?.()).toBe(false);
    const paramsJSON = JSON.stringify({ agentId: "main", limit: 1 });
    const listed = observe(command.handle(paramsJSON));
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

      const reconnected = observe(command.handle(paramsJSON));
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

  it("reconnects cold hydration after the old connection closes", async () => {
    const first = observe(h.control.initialize());
    const old = await h.frame(0);
    old.transport.emitExit();
    await expect(first).rejects.toThrow();

    const current = observe(h.control.initialize());
    const replacement = await h.frame(1);
    expect(replacement.transport.client).not.toBe(old.transport.client);
    h.reply(replacement, "reconnected");
    await current;
    await expectPage(h.control.listPage({}), "reconnected");
    expect(h.work).toMatchObject({ frames: 2, transports: 2 });
  });
});
