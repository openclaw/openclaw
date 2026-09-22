import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as diagnosticRuntime from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
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
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

type ListFrame = { id: number; params: CodexThreadListParams };
type CatalogResources = {
  transports: ReturnType<typeof createClientHarness>[];
  companion?: CodexAppServerClient;
};
const REQUEST_TIMEOUT_MS = 200;
const SLOW_DIAGNOSTIC_REQUEST_TIMEOUT_MS = 2_000;

function page(threadId: string) {
  return {
    data: [{ ...threadStartResult(threadId).thread, source: "cli" }],
    nextCursor: null,
  };
}

function poll(
  control: CodexSessionCatalogControl,
  params: CodexSessionCatalogPageParams = { limit: 1 },
) {
  const pending = control.listPage(params);
  // Observe rejection immediately, including when a failing assertion enters cleanup first.
  void pending.catch(() => undefined);
  return pending;
}

async function createCatalogHarness(agentDir: string, resources: CatalogResources) {
  const { transports } = resources;
  const frames: Array<ListFrame & { transport: ReturnType<typeof createClientHarness> }> = [];
  vi.spyOn(CodexAppServerClient, "start").mockImplementation(async () => {
    const transport = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as ListFrame & { method: string };
        if (message.method === "initialize") {
          send({ id: message.id, result: { userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}` } });
        } else if (message.method === "model/list" || message.params?.cursor === "warm") {
          send({ id: message.id, result: { data: [] } });
        } else if (message.method === "thread/list") {
          frames.push({ ...message, transport });
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
      url: "ws://127.0.0.1:1",
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
  };
  let now = 1_000;
  const newFactory = (requestTimeoutMs = REQUEST_TIMEOUT_MS) =>
    createCodexSessionCatalogControl({
      getPluginConfig: () => ({
        ...pluginConfig,
        appServer: { ...pluginConfig.appServer, requestTimeoutMs },
      }),
      getRuntimeConfig: () => config,
      resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
      now: () => now,
      env: {},
    });
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
  await control.listPage({ cursor: "warm", limit: 1 });
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
    expirePage: () => {
      now += 32_001;
    },
    async frame(index: number) {
      return await vi.waitFor(
        () => {
          const frame = frames[index];
          assert(frame, `Expected catalog request ${index}`);
          return frame;
        },
        { interval: 1 },
      );
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
    async waitForRefresh(requestCount: number) {
      await vi.waitFor(
        () =>
          expect(requests.mock.calls.filter(([method]) => method === "thread/list")).toHaveLength(
            requestCount,
          ),
        { interval: 1 },
      );
      expect(getCurrentSharedClientEntry(companion)?.activeLeases).toBe(2);
    },
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

describe("catalog request lifetime across page-cache polls", () => {
  let agentDir: string;
  let h: Awaited<ReturnType<typeof createCatalogHarness>>;
  let resources: CatalogResources;

  beforeEach(async () => {
    resources = { transports: [] };
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-catalog-lifetime-"));
    h = await createCatalogHarness(agentDir, resources);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (resources.companion) {
      releaseLeasedSharedCodexAppServerClient(resources.companion);
    }
    const closed = await Promise.allSettled(
      resources.transports.map(({ client }) => client.closeAndWait()),
    );
    vi.restoreAllMocks();
    await fs.rm(agentDir, { recursive: true, force: true });
    expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
  });

  it("splits a successful control wait at the existing client request boundary", async () => {
    const control = h.createSlowDiagnosticsControl();
    await withPageDiagnostics(async (records, advanceClock) => {
      const pending = poll(control, { cursor: "timed-success", limit: 1 });
      const frame = await h.frame(0);
      advanceClock();
      h.reply(frame, "timed-success");
      await expect(pending).resolves.toMatchObject({
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
      const pending = poll(control, { cursor: "rejected", limit: 1 });
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

  it("keeps control observations local to calls on a reusable pinned snapshot", async () => {
    const control = h.createSlowDiagnosticsControl();
    await withPageDiagnostics(async (records, advanceClock) => {
      await control.withPinnedConnection(async (pinned) => {
        expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(2);
        for (const [index, code] of [null, -32601, -32603].entries()) {
          const pending = poll(pinned, { cursor: `pinned-${index}`, limit: 1 });
          const settled =
            code === null
              ? expect(pending).resolves.toMatchObject({
                  sessions: [{ threadId: "pinned-success" }],
                })
              : expect(pending).rejects.toMatchObject({ code });
          const frame = await h.frame(index);
          advanceClock();
          if (code === null) {
            h.reply(frame, "pinned-success");
          } else {
            frame.transport.send({
              id: frame.id,
              error: { code, message: "synthetic-private-error" },
            });
          }
          await settled;
          expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(2);
        }
      });
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records.map((record) => record.attributes?.controlFailureCategory)).toEqual([
        undefined,
        "rpc-method-unavailable",
        "rpc-error",
      ]);
      expect(records.map((record) => record.attributes?.controlFailurePhase)).toEqual([
        undefined,
        "client-request",
        "client-request",
      ]);
      for (const record of records) {
        expect(record.attributes).toMatchObject({
          controlLoadMs: 0,
          controlPrepareMs: 0,
          controlClientRequestMs: 1_500,
        });
        expect(record.attributes).not.toHaveProperty("controlAcquireClientMs");
        expect(record.attributes).not.toHaveProperty("controlReleaseClientMs");
      }
      expect(new Set(records.map((record) => record.attributes?.operationId)).size).toBe(3);
      expect(getCurrentSharedClientEntry(h.companion)?.activeLeases).toBe(1);
      await expect(
        h.companion.request("thread/list", { cursor: "warm" }, { timeoutMs: REQUEST_TIMEOUT_MS }),
      ).resolves.toEqual({ data: [] });
      expect(JSON.stringify(records)).not.toContain("synthetic-private-error");
    });
  });

  it("lets a fresh cold poll fulfill the existing request without reviving its expired caller", async () => {
    await withPageDiagnostics(async (records, advanceClock) => {
      const first = poll(h.control);
      const frame = await h.frame(0);
      advanceClock();
      await h.expireWaiter();
      await expect(first).rejects.toThrow("thread/list timed out");
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        outcome: "rejected",
        controlClientRequestMs: 1_500,
      });

      const current = poll(h.control);
      await h.waitForRefresh(2);
      expect(h.frames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS / 2);
      advanceClock(REQUEST_TIMEOUT_MS / 2);
      h.reply(frame, "current-result");
      await expect(current).resolves.toMatchObject({ sessions: [{ threadId: "current-result" }] });
      await expect(first).rejects.toThrow("thread/list timed out");
      expect(h.frames).toHaveLength(1);
      await expect(h.companion.request("model/list", {})).resolves.toEqual({ data: [] });
      expect(h.transports).toHaveLength(1);
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      // The fresh poll resolves within its 200ms budget, below the slow-log threshold.
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes?.outcome).toBe("rejected");
    });
  });

  it("serves stale pages immediately while a current refresh joins the expired refresh's request", async () => {
    const seed = poll(h.control);
    h.reply(await h.frame(0), "stale");
    const stale = await seed;
    h.expirePage();
    await expect(poll(h.control)).resolves.toEqual(stale);
    const refresh = await h.frame(1);
    await h.expireWaiter();

    await expect(poll(h.control)).resolves.toEqual(stale);
    await h.waitForRefresh(3);
    expect(h.frames).toHaveLength(2);
    h.reply(refresh, "refreshed");
    await vi.waitFor(async () => {
      await expect(poll(h.control)).resolves.toMatchObject({
        sessions: [{ threadId: "refreshed" }],
      });
    });
    expect(h.frames).toHaveLength(2);
  });

  it("discards an unobserved late refresh reply instead of making the stale page fresh", async () => {
    const seed = poll(h.control);
    h.reply(await h.frame(0), "stale");
    const stale = await seed;
    h.expirePage();
    await expect(poll(h.control)).resolves.toEqual(stale);
    const expired = await h.frame(1);
    await h.expireWaiter();
    h.reply(expired, "unobserved");
    await nextTurn();

    await expect(poll(h.control)).resolves.toEqual(stale);
    h.reply(await h.frame(2), "current-refresh");
    await vi.waitFor(async () => {
      await expect(poll(h.control)).resolves.toMatchObject({
        sessions: [{ threadId: "current-refresh" }],
      });
    });
    expect(h.frames).toHaveLength(3);
  });

  it.each(["config", "factory", "agent", "home", "query"] as const)(
    "does not join an expired request from another %s partition",
    async (partition) => {
      const first = poll(h.control);
      const expired = await h.frame(0);
      await h.expireWaiter();
      await expect(first).rejects.toThrow("thread/list timed out");
      let control = h.control;
      let params: CodexSessionCatalogPageParams = { limit: 1 };
      if (partition === "config") {
        h.replaceConfig();
      } else if (partition === "factory") {
        control = h.newFactory().forRequest("main");
      } else if (partition === "agent") {
        control = h.factory.forRequest("other");
      } else if (partition === "home") {
        const [home] = await h.factory.homesForAgent("main");
        assert(home);
        control = h.factory.forRequest("main", {
          ...home,
          sourceHomeId: "separate-home",
        });
      } else {
        params = { limit: 1, cursor: "separate-query" };
      }
      const current = poll(control, params);
      const independent = await h.frame(1);
      // The semantic partition must survive even when normal acquisition selects one client.
      expect(independent.transport.client).toBe(expired.transport.client);
      h.reply(independent, "partition-result");
      await expect(current).resolves.toMatchObject({
        sessions: [{ threadId: "partition-result" }],
      });
      h.reply(expired, "old-result");
      await expect(first).rejects.toThrow("thread/list timed out");
      expect(h.frames).toHaveLength(2);
    },
  );

  it("allows an independently initiated poll to reconnect after the old connection closes", async () => {
    const first = poll(h.control);
    const old = await h.frame(0);
    old.transport.emitExit();
    await expect(first).rejects.toThrow();

    const current = poll(h.control);
    const replacement = await h.frame(1);
    expect(replacement.transport.client).not.toBe(old.transport.client);
    h.reply(replacement, "reconnected");
    await expect(current).resolves.toMatchObject({ sessions: [{ threadId: "reconnected" }] });
    expect(h.frames).toHaveLength(2);
    expect(h.transports).toHaveLength(2);
  });
});
