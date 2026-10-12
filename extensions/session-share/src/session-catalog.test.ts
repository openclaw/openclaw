import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionShareCatalog } from "./session-catalog.js";

const diagnostics = vi.hoisted(() => ({ enabled: false, warnEnabled: true, warn: vi.fn() }));
vi.mock("openclaw/plugin-sdk/diagnostic-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/diagnostic-runtime")>();
  return {
    ...actual,
    areDiagnosticsEnabledForProcess: () => diagnostics.enabled,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/session-catalog"
        ? { ...logger, isEnabled: () => diagnostics.warnEnabled, warn: diagnostics.warn }
        : logger;
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((stop) => stop()));
  diagnostics.enabled = false;
  diagnostics.warn.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const commands = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
const nativeSession: SessionCatalogSession = {
  threadId: "agent:main:shared",
  name: "Shared session",
  status: "idle",
  archived: false,
  canContinue: false,
  canArchive: false,
  canOpenTerminal: false,
};
const remoteIdentity = {
  type: "remote" as const,
  pluginId: "session-share",
  domain: "source",
  idKind: "github-account",
  id: "4242",
};

async function catalogFixture() {
  let config: OpenClawConfig = {};
  const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
    nodes: [{ nodeId: "alpha", displayName: " Alpha ", connected: true, commands }],
  });
  const invoke = vi
    .fn<PluginRuntime["nodes"]["invoke"]>()
    .mockImplementation(async ({ command }) => {
      if (command !== commands[0]) {
        throw new Error("Unexpected node command");
      }
      return { payloadJSON: JSON.stringify({ sessions: [nativeSession] }) };
    });
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  let service: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const api = createTestPluginApi({
    runtime,
    registerService: (registered) => {
      service = registered;
    },
  });
  const catalog = createSessionShareCatalog(api);
  let scheduler = createTestPluginServiceScheduler();
  let serviceContext = {
    config,
    logger: api.logger,
    stateDir: "/unused",
    invokeNode: invoke,
    scheduler,
  };
  await service?.start(serviceContext);
  const fixture = {
    catalog,
    list,
    invoke,
    hydrate: async () => {
      await catalog.list({});
      await vi.advanceTimersByTimeAsync(2);
    },
    stop: async () => {
      scheduler.beginClose();
      try {
        await service?.stop?.(serviceContext);
      } finally {
        await scheduler.stop();
      }
    },
    configure: (next: OpenClawConfig) => {
      config = next;
    },
    restart: async (): Promise<void> => {
      await fixture.stop();
      scheduler = createTestPluginServiceScheduler();
      serviceContext = { ...serviceContext, config, scheduler };
      await service?.start(serviceContext);
    },
  };
  cleanups.push(fixture.stop);
  return fixture;
}

describe("session-share receiver catalog", () => {
  it("bounds requested-node admission and refresh concurrency without interrupting admitted work", async () => {
    const fixture = await catalogFixture();
    fixture.list.mockResolvedValue({
      nodes: Array.from({ length: 40 }, (_, index) => ({
        nodeId: `node-${String(index).padStart(2, "0")}`,
        connected: true,
        commands,
      })),
    });
    const gate = createDeferred<unknown>();
    let active = 0;
    let peak = 0;
    fixture.invoke.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await gate.promise;
      } finally {
        active--;
      }
    });
    try {
      await vi.advanceTimersByTimeAsync(30_005);
      expect(fixture.invoke).not.toHaveBeenCalled();
      await fixture.catalog.list({ hostIds: ["node:node-39"] });
      await vi.advanceTimersByTimeAsync(2);
      expect(fixture.invoke.mock.calls.map(([request]) => request.nodeId)).toEqual(["node-39"]);
      await fixture.catalog.list({});
      await vi.advanceTimersByTimeAsync(2);
      expect(fixture.invoke).toHaveBeenCalledTimes(4);
      expect(peak).toBe(4);
      const waiting = await fixture.catalog.list({ hostIds: ["node:node-38"] });
      expect(waiting[0]?.error?.code).toBe("CATALOG_LOADING");
      gate.resolve({ sessions: [nativeSession] });
      await vi.advanceTimersByTimeAsync(2);
      expect(fixture.invoke).toHaveBeenCalledTimes(32);
      expect(peak).toBe(4);
      await fixture.catalog.list({ hostIds: ["node:node-38"] });
      await vi.advanceTimersByTimeAsync(2);
      expect((await fixture.catalog.list({ hostIds: ["node:node-38"] }))[0]?.sessions).toEqual([
        nativeSession,
      ]);
      expect(fixture.invoke).toHaveBeenCalledTimes(33);
      await vi.advanceTimersByTimeAsync(30_010);
      const refreshed = fixture.invoke.mock.calls.slice(33).map(([request]) => request.nodeId);
      expect(refreshed).toHaveLength(32);
      expect(refreshed).not.toContain("node-39");
      expect(refreshed).toContain("node-38");
    } finally {
      gate.resolve({ sessions: [] });
    }
  });

  it("restarts after retiring queued refreshes before dispatch", async () => {
    const fixture = await catalogFixture();
    const publications: Promise<void>[] = [];
    await fixture.catalog.list({
      allowPartialResults: true,
      onHost: () => {},
      waitUntil: (work) => publications.push(work),
    });
    await fixture.restart();
    await Promise.all(publications);
    await fixture.hydrate();
    expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([nativeSession]);
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
  });

  it("serves searches and pages from one complete node snapshot until refresh", async () => {
    const fixture = await catalogFixture();
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...nativeSession,
      threadId: `agent:main:${index}`,
      name: `Shared ${index}`,
    }));
    fixture.invoke.mockImplementation(async ({ params }) => {
      const { cursor } = params as { cursor?: string };
      return cursor
        ? { sessions: rows.slice(100) }
        : {
            sessions: rows.slice(0, 100),
            nextCursor: sessionCatalogPaging.encodeCursor(100),
          };
    });
    expect((await fixture.catalog.list({}))[0]?.error?.code).toBe("CATALOG_LOADING");
    await vi.advanceTimersByTimeAsync(2);
    const first = (await fixture.catalog.list({ limitPerHost: 100 }))[0]!;
    expect(first.sessions).toEqual(rows.slice(0, 100));
    expect(
      (await fixture.catalog.list({ cursors: { "node:alpha": first.nextCursor! } }))[0]?.sessions,
    ).toEqual(rows.slice(100));
    expect((await fixture.catalog.list({ search: "SHARED 100" }))[0]?.sessions).toEqual(
      rows.slice(100),
    );
    expect((await fixture.catalog.list({ search: "MAIN:100" }))[0]?.sessions).toEqual(
      rows.slice(100),
    );
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    fixture.invoke.mockResolvedValue({ sessions: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([]);
    expect(fixture.invoke).toHaveBeenCalledTimes(3);
  });

  it("finishes a multi-page snapshot when slow successful pages exceed one invocation budget", async () => {
    const fixture = await catalogFixture();
    const rows = Array.from({ length: 601 }, (_, index) => ({
      ...nativeSession,
      threadId: `agent:main:${index}`,
    }));
    fixture.invoke.mockImplementation(async ({ params }) => {
      const { cursor } = params as { cursor?: string };
      const offset = sessionCatalogPaging.decodeCursor(cursor);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5_000);
      });
      return {
        sessions: rows.slice(offset, offset + 100),
        ...(offset + 100 < rows.length
          ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + 100) }
          : {}),
      };
    });
    await fixture.catalog.list({});
    await vi.advanceTimersByTimeAsync(35_005);
    const hosts = await fixture.catalog.list({
      cursors: { "node:alpha": sessionCatalogPaging.encodeCursor(600) },
    });
    expect(hosts[0]?.sessions).toEqual(rows.slice(600));
    expect(hosts[0]?.error).toBeUndefined();
    expect(fixture.invoke).toHaveBeenCalledTimes(7);
  });

  it.each(["rows", "bytes"])(
    "bounds aggregate snapshot %s without publishing a truncated catalog",
    async (budget) => {
      const fixture = await catalogFixture();
      const total = budget === "rows" ? 10_100 : 1_500;
      const text = "x".repeat(6_000);
      fixture.invoke.mockImplementation(async ({ params }) => {
        const { cursor } = params as { cursor?: string };
        const offset = sessionCatalogPaging.decodeCursor(cursor);
        return {
          sessions: Array.from({ length: 100 }, (_, index) => ({
            ...nativeSession,
            threadId: `agent:main:${offset + index}`,
            ...(budget === "bytes" ? { name: text, cwd: text, gitBranch: text } : {}),
          })),
          ...(offset + 100 < total
            ? { nextCursor: sessionCatalogPaging.encodeCursor(offset + 100) }
            : {}),
        };
      });
      await fixture.hydrate();
      const host = (await fixture.catalog.list({}))[0];
      expect(host?.error?.code).toBe("CATALOG_TOO_LARGE");
      expect(host?.sessions).toEqual([]);
      expect(host?.error?.message).toContain("Reduce the shared groups");
    },
  );

  it("backs off failed refreshes and expires snapshots despite a backward wall-clock adjustment", async () => {
    const fixture = await catalogFixture();
    await fixture.hydrate();
    fixture.invoke.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(30_005);
    expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([nativeSession]);
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_005);
    const wallNow = Date.now();
    vi.setSystemTime(wallNow - 86_400_000);
    for (let index = 0; index < 10; index++) {
      expect((await fixture.catalog.list({}))[0]).toMatchObject({
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED" },
      });
    }
    vi.setSystemTime(wallNow);
    expect(fixture.invoke).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.invoke).toHaveBeenCalledTimes(3);
    fixture.invoke.mockResolvedValue({ sessions: [] });
    await vi.advanceTimersByTimeAsync(30_005);
    expect((await fixture.catalog.list({}))[0]?.error).toBeUndefined();
    expect(fixture.invoke).toHaveBeenCalledTimes(4);
  });

  it.each(["config", "connection", "disconnect"])(
    "invalidates a snapshot on %s and rejects its late refresh",
    async (revision) => {
      const fixture = await catalogFixture();
      await fixture.hydrate();
      const gate = createDeferred<unknown>();
      fixture.invoke.mockImplementationOnce(() => gate.promise);
      await vi.advanceTimersByTimeAsync(30_000);
      const publications: Promise<void>[] = [];
      const onHost = vi.fn();
      await fixture.catalog.list({
        allowPartialResults: true,
        onHost,
        waitUntil: (work) => publications.push(work),
      });
      if (revision === "config") {
        fixture.configure({ gateway: { port: 12345 } });
      } else {
        fixture.list.mockResolvedValue({
          nodes: [
            { nodeId: "alpha", connected: revision !== "disconnect", connectedAtMs: 2, commands },
          ],
        });
      }
      const hosts = await fixture.catalog.list({});
      expect(hosts[0]?.sessions).toEqual([]);
      gate.resolve({ sessions: [{ ...nativeSession, name: "Retired publication" }] });
      await Promise.all(publications);
      expect(onHost).not.toHaveBeenCalled();
      if (revision !== "disconnect") {
        await vi.advanceTimersByTimeAsync(2);
        expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([nativeSession]);
      } else {
        expect(hosts[0]?.error?.code).toBe("NODE_OFFLINE");
      }
    },
  );

  it("keeps background refresh owned by the service after a viewer cancels", async () => {
    const fixture = await catalogFixture();
    const gate = createDeferred<unknown>();
    fixture.invoke.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    const onHost = vi.fn();
    const publications: Promise<void>[] = [];
    await fixture.catalog.list({
      signal: controller.signal,
      allowPartialResults: true,
      onHost,
      waitUntil: (work) => publications.push(work),
    });
    onHost.mockClear();
    await vi.advanceTimersByTimeAsync(2);
    controller.abort();
    expect(fixture.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    gate.resolve({ sessions: [nativeSession] });
    await Promise.all(publications);
    expect(onHost).not.toHaveBeenCalled();
    expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([nativeSession]);
    expect(fixture.invoke).toHaveBeenCalledTimes(1);
  });

  it("cancels and joins active node work when the service retires", async () => {
    const fixture = await catalogFixture();
    const release = createDeferred<unknown>();
    let signal: AbortSignal | undefined;
    fixture.invoke.mockImplementation((request) => {
      signal = request.signal;
      return release.promise;
    });
    const publications: Promise<void>[] = [];
    const onHost = vi.fn();
    await fixture.catalog.list({
      allowPartialResults: true,
      onHost,
      waitUntil: (work) => publications.push(work),
    });
    onHost.mockClear();
    await vi.advanceTimersByTimeAsync(2);
    let stopped = false;
    const stopping = fixture.stop().then(() => {
      stopped = true;
    });
    await Promise.all(publications);
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    release.resolve({ sessions: [nativeSession] });
    await stopping;
    expect(onHost).not.toHaveBeenCalled();
    expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([]);
  });

  it.each([1, 2])("stops a %s-host publication when its catalog owner retires", async (count) => {
    const fixture = await catalogFixture();
    fixture.list.mockResolvedValue({
      nodes: ["alpha", "beta"]
        .slice(0, count)
        .map((nodeId) => ({ nodeId, connected: true, commands })),
    });
    const controller = new AbortController();
    const reason = new Error("catalog owner retired");
    const onHost = vi.fn(() => controller.abort(reason));
    await expect(fixture.catalog.list({ signal: controller.signal, onHost })).rejects.toBe(reason);
    expect(onHost).toHaveBeenCalledTimes(1);
  });

  it("does not start catalog work after cancellation during node discovery", async () => {
    const fixture = await catalogFixture();
    const gate = createDeferred<Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>>();
    const controller = new AbortController();
    const listing = fixture.catalog.list({
      signal: controller.signal,
      listNodes: () => gate.promise,
    });
    const reason = new Error("viewer retired");
    controller.abort(reason);
    gate.resolve({ nodes: [] });
    await expect(listing).rejects.toBe(reason);
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "preserves slow refresh dispatch attribution (%s) with rate-limited private-safe logs",
    async (nodeCommandDispatched) => {
      diagnostics.enabled = true;
      diagnostics.warnEnabled = true;
      const fixture = await catalogFixture();
      fixture.list.mockResolvedValue({
        nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, connected: true, commands })),
      });
      const gate = createDeferred<unknown>();
      fixture.invoke.mockImplementation(() => gate.promise);
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      await fixture.hydrate();
      clock = 30_000;
      gate.reject(
        Object.assign(new Error("PRIVATE_MESSAGE"), {
          name: "GatewayClientRequestError",
          gatewayCode: nodeCommandDispatched === undefined ? "PRIVATE_CODE" : "UNAVAILABLE",
          details: {
            nodeCommandDispatched,
            nodeError: {
              code: nodeCommandDispatched === undefined ? "PRIVATE_CODE" : "TIMEOUT",
              message: "PRIVATE_MESSAGE",
            },
            nodeId: "PRIVATE_NODE",
            params: { searchTerm: "PRIVATE_SEARCH" },
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect((await fixture.catalog.list({}))[0]).toMatchObject({
        sessions: [],
        error: { code: "NODE_INVOKE_FAILED" },
      });
      expect(diagnostics.warn.mock.calls).toEqual([
        [
          "slow Session Share catalog refresh",
          {
            elapsedMs: 30_000,
            outcome: "rejected",
            nodeErrorCode: nodeCommandDispatched === undefined ? "unknown" : "TIMEOUT",
            ...(nodeCommandDispatched !== undefined ? { nodeCommandDispatched } : {}),
          },
        ],
      ]);
    },
  );

  it.each(["level disabled", "disabled before settlement", "sink throws", "fast"])(
    "preserves successful refreshes when diagnostics are %s",
    async (mode) => {
      diagnostics.enabled = true;
      diagnostics.warnEnabled = mode !== "level disabled";
      if (mode === "sink throws") {
        diagnostics.warn.mockImplementation(() => {
          throw new Error("diagnostic sink failed");
        });
      }
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      const fixture = await catalogFixture();
      const invoke = fixture.invoke.getMockImplementation()!;
      fixture.invoke.mockImplementation(async (params) => {
        clock += mode === "fast" ? 999 : 1_200;
        if (mode === "disabled before settlement") {
          diagnostics.enabled = false;
        }
        return invoke(params);
      });

      await fixture.hydrate();
      expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([nativeSession]);
      expect(diagnostics.warn).toHaveBeenCalledTimes(mode === "sink throws" ? 1 : 0);
    },
  );

  it("namespaces colliding profile claims by the invoked node, not the claimed node domain", async () => {
    const fixture = await catalogFixture();
    fixture.list.mockResolvedValue({
      nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, commands, connected: true })),
    });
    const identity = {
      ...remoteIdentity,
      domain: "node:alpha",
      idKind: "profile",
      id: "same-profile",
    };
    fixture.invoke.mockImplementation(async ({ command }) => ({
      payloadJSON: JSON.stringify(
        command === commands[0]
          ? {
              sessions: [{ ...nativeSession, createdActor: { type: "human", identity } }],
            }
          : {
              threadId: nativeSession.threadId,
              items: [{ type: "userMessage", text: "Question", sender: { identity } }],
            },
      ),
    }));
    await fixture.hydrate();
    const hosts = await fixture.catalog.list({});
    const pages = await Promise.all(
      hosts.map(({ hostId }) => fixture.catalog.read({ hostId, threadId: nativeSession.threadId })),
    );
    const expected = [
      { ...identity, domain: "node:alpha" },
      { ...identity, domain: "node:beta" },
    ];
    expect.soft(hosts.map((host) => host.sessions[0]?.createdActor?.identity)).toEqual(expected);
    expect(pages.map((page) => page.items[0]?.sender?.identity)).toEqual(expected);
  });

  it("preserves eligible host order and separates offline and failed sources", async () => {
    const fixture = await catalogFixture();
    fixture.list.mockResolvedValue({
      nodes: [
        { nodeId: "partial", commands: [commands[0]!], connected: true },
        { nodeId: "offline", displayName: "Bravo", commands, connected: false },
        { nodeId: "broken", displayName: "Charlie", commands, connected: true },
        { nodeId: "alpha", displayName: "Alpha", commands, connected: true },
      ],
    });
    fixture.invoke.mockImplementation(async ({ nodeId }) => {
      if (nodeId === "broken") {
        throw new Error("disconnected");
      }
      return { sessions: [nativeSession] };
    });
    await fixture.hydrate();
    const hosts = await fixture.catalog.list({});
    expect(hosts.map((host) => host.hostId)).toEqual(["node:alpha", "node:offline", "node:broken"]);
    expect(hosts[0]?.sessions).toEqual([nativeSession]);
    expect(hosts[1]?.error?.code).toBe("NODE_OFFLINE");
    expect(hosts[2]?.error?.code).toBe("NODE_INVOKE_FAILED");
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    expect(fixture.catalog.continueSession).toBeUndefined();
    expect(fixture.catalog.archive).toBeUndefined();
    expect(fixture.catalog.openTerminal).toBeUndefined();
  });

  it.each([
    { nodeId: "alpha", commands, connected: false },
    { nodeId: "alpha", commands: [commands[0]!], connected: true },
  ])("denies reads when the paired host is unavailable: %j", async (node) => {
    const fixture = await catalogFixture();
    fixture.list.mockResolvedValue({ nodes: [node] });
    await expect(
      fixture.catalog.read({ hostId: "node:alpha", threadId: nativeSession.threadId }),
    ).rejects.toThrow("unavailable");
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "local profile",
      patch: { createdActor: { type: "human", identity: { type: "profile", id: "forged" } } },
    },
    { label: "local adoption", patch: { sessionKey: "agent:main:local" } },
    { label: "write capability", patch: { canContinue: true } },
  ])("rejects node rows carrying $label", async ({ patch }) => {
    const fixture = await catalogFixture();
    fixture.invoke.mockResolvedValue({
      payloadJSON: JSON.stringify({ sessions: [{ ...nativeSession, ...patch }] }),
    });
    await fixture.hydrate();
    const hosts = await fixture.catalog.list({});
    expect(hosts[0]).toMatchObject({ sessions: [], error: { code: "NODE_INVOKE_FAILED" } });
  });

  it.each([{ sender: { identity: { type: "profile", id: "forged" } } }, { unexpected: true }])(
    "rejects transcript payload outside the closed wire identity contract: %j",
    async (patch) => {
      const fixture = await catalogFixture();
      fixture.invoke.mockResolvedValue({
        payloadJSON: JSON.stringify({
          threadId: nativeSession.threadId,
          items: [{ type: "userMessage", text: "Question", ...patch }],
        }),
      });
      await expect(
        fixture.catalog.read({ hostId: "node:alpha", threadId: nativeSession.threadId }),
      ).rejects.toThrow("Invalid OpenClaw transcript");
    },
  );
});
