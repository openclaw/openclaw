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
  type SessionCatalogProvider,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

let f: Awaited<ReturnType<typeof catalogFixture>>;
beforeEach(async () => {
  vi.useFakeTimers();
  f = await catalogFixture();
});
afterEach(async () => {
  await f.stop();
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
type CatalogQuery = Parameters<SessionCatalogProvider["list"]>[0];
const { encodeCursor, decodeCursor } = sessionCatalogPaging;
const wire = (value: unknown) => ({ payloadJSON: JSON.stringify(value) });
const transcript = (fields: Record<string, unknown>) => ({
  threadId: nativeSession.threadId,
  items: [{ type: "userMessage", text: "Question", ...fields }],
});
const makeNode = (nodeId: string) => ({ nodeId, connected: true, commands });
const advance = (ms = 2) => vi.advanceTimersByTimeAsync(ms);
const rows = (length: number, fields: Partial<SessionCatalogSession> = {}) =>
  Array.from({ length }, (_, index) => ({
    ...nativeSession,
    threadId: `agent:main:${index}`,
    name: `Shared ${index}`,
    ...fields,
  }));

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
      return wire({ sessions: [nativeSession] });
    });
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
  const api = createTestPluginApi({ runtime, registerService });
  const catalog = createSessionShareCatalog(api);
  const service = registerService.mock.calls[0]![0];
  let scheduler = createTestPluginServiceScheduler();
  let serviceContext = {
    config,
    logger: api.logger,
    stateDir: "/unused",
    invokeNode: invoke,
    scheduler,
  };
  await service.start(serviceContext);
  let readDelayMs = 2;
  const readList = async (query: CatalogQuery = {}) => {
    const listing = catalog.list(query);
    void listing.catch(() => {});
    await advance(readDelayMs);
    return listing;
  };
  const begin = (query: CatalogQuery = {}) =>
    catalog.list({ allowPartialResults: true, onHost: () => {}, waitUntil: () => {}, ...query });
  const result = {
    readList,
    begin,
    catalog,
    list,
    invoke,
    expectCallsAfter: async (ms: number, count: number) => {
      await advance(ms);
      expect(invoke).toHaveBeenCalledTimes(count);
    },
    nodes: (...ids: string[]) => list.mockResolvedValue({ nodes: ids.map(makeNode) }),
    host: async (query: CatalogQuery = {}) => (await readList(query))[0],
    read: (hostId = "node:alpha") => catalog.read({ hostId, threadId: nativeSession.threadId }),
    expectSessions: async (sessions = [nativeSession], query: CatalogQuery = {}) =>
      expect((await readList(query))[0]?.sessions).toEqual(sessions),
    watch: async (query: CatalogQuery = {}) => {
      const publications: Promise<void>[] = [];
      const onHost = vi.fn();
      await begin({ ...query, onHost, waitUntil: (work) => publications.push(work) });
      return { done: () => Promise.all(publications), onHost };
    },
    paginate: (sessions: SessionCatalogSession[], delayMs = 0) => {
      readDelayMs = Math.ceil(sessions.length / 100) * delayMs + 2;
      invoke.mockImplementation(async ({ params }) => {
        const { cursor } = params as { cursor?: string };
        const offset = decodeCursor(cursor);
        if (delayMs) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        return {
          sessions: sessions.slice(offset, offset + 100),
          ...(offset + 100 < sessions.length ? { nextCursor: encodeCursor(offset + 100) } : {}),
        };
      });
    },
    hydrate: async () => {
      await begin();
      await advance();
    },
    stop: async () => {
      scheduler.beginClose();
      try {
        await service.stop?.(serviceContext);
      } finally {
        await scheduler.stop();
      }
    },
    configure: (next: OpenClawConfig) => {
      config = next;
    },
    restart: async (): Promise<void> => {
      await result.stop();
      scheduler = createTestPluginServiceScheduler();
      serviceContext = { ...serviceContext, config, scheduler };
      await service.start(serviceContext);
    },
  };
  return result;
}

it.each(["runtime", "request snapshot"])(
  "propagates %s discovery failures and recovers",
  async (route) => {
    f.list.mockRejectedValueOnce(new Error("paired node inventory is unavailable"));
    await expect(
      f.readList(route === "request snapshot" ? { listNodes: f.list } : {}),
    ).rejects.toThrow("Cannot discover OpenClaw session sources. Refresh the catalog to retry.");
    expect(f.invoke).not.toHaveBeenCalled();

    await f.expectSessions();
    f.list.mockResolvedValueOnce({ nodes: [] });
    expect(await f.readList({})).toEqual([]);
  },
);

it("bounds admission and refresh concurrency without interrupting work", async () => {
  f.nodes(...Array.from({ length: 40 }, (_, index) => `node-${String(index).padStart(2, "0")}`));
  const gate = createDeferred<unknown>();
  let active = 0;
  let peak = 0;
  f.invoke.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    return gate.promise.finally(() => active--);
  });
  try {
    await advance(30_005);
    expect(f.invoke).not.toHaveBeenCalled();
    await f.begin({ hostIds: ["node:node-39"] });
    await advance();
    expect(f.invoke.mock.calls.map(([request]) => request.nodeId)).toEqual(["node-39"]);
    await f.begin();
    await advance();
    expect({ calls: f.invoke.mock.calls.length, peak }).toEqual({ calls: 4, peak: 4 });
    const waiting = await f.begin({ hostIds: ["node:node-38"] });
    expect(waiting[0]?.error?.code).toBe("CATALOG_LOADING");
    gate.resolve({ sessions: [nativeSession] });
    await advance();
    expect({ calls: f.invoke.mock.calls.length, peak }).toEqual({ calls: 32, peak: 4 });
    await f.expectSessions([nativeSession], { hostIds: ["node:node-38"] });
    f.invoke.mockClear();
    await advance(30_010);
    const refreshed = f.invoke.mock.calls.map(([request]) => request.nodeId);
    expect(refreshed).toHaveLength(32);
    expect(refreshed).not.toContain("node-39");
    expect(refreshed).toContain("node-38");
  } finally {
    gate.resolve({ sessions: [] });
  }
});

it("restarts after retiring queued refreshes before dispatch", async () => {
  const { done } = await f.watch();
  await f.restart();
  await done();
  expect(f.invoke).not.toHaveBeenCalled();
  await f.expectSessions();
});

it.each(["München", "Mu\u0308nchen"])("pages and finds %s", async (title) => {
  const sessions = rows(601);
  sessions[100]!.name = title;
  f.paginate(sessions, 5_000);
  expect((await f.begin())[0]?.pending).toBe(true);
  await advance(35_005);
  const first = (await f.host({ limitPerHost: 100 }))!;
  expect(first.sessions).toEqual(sessions.slice(0, 100));
  expect(first.error).toBeUndefined();
  await f.expectSessions(sessions.slice(100, 200), {
    limitPerHost: 100,
    cursors: { "node:alpha": first.nextCursor! },
  });
  await f.expectSessions(sessions.slice(600), { cursors: { "node:alpha": encodeCursor(600) } });
  const query = title === "München" ? "Mu\u0308nchen" : "München";
  await f.expectSessions([sessions[100]!], { search: query.toUpperCase() });
  await f.expectSessions([sessions[100]!], { search: "MAIN:100" });
  f.invoke.mockResolvedValue({ sessions: [] });
  await advance(30_000);
  await f.expectSessions([]);
});

it.each(["rows", "bytes"])("rejects oversized snapshot %s", async (budget) => {
  const total = budget === "rows" ? 10_100 : 1_500;
  const text = "x".repeat(6_000);
  f.paginate(rows(total, budget === "bytes" ? { name: text, cwd: text, gitBranch: text } : {}));
  await f.hydrate();
  expect(await f.host()).toMatchObject({
    sessions: [],
    error: {
      code: "CATALOG_TOO_LARGE",
      message: expect.stringContaining("Reduce the shared groups"),
    },
  });
});

it("backs off scheduled refresh failures across a wall-clock change", async () => {
  await f.hydrate();
  f.invoke.mockRejectedValue(new Error("offline"));
  await f.expectCallsAfter(30_005, 2);
  await f.expectCallsAfter(30_005, 3);
  vi.setSystemTime(Date.now() - 86_400_000);
  await f.expectCallsAfter(59_000, 3);
  await f.expectCallsAfter(1_005, 4);
  f.invoke.mockResolvedValue({ sessions: [] });
  expect(await f.host()).toMatchObject({ sessions: [] });
  expect((await f.host())?.error).toBeUndefined();
});

it.each(["failure", "config", "connection", "disconnect"])(
  "withdraws %s snapshots",
  async (revision) => {
    await f.expectSessions();
    const gate = createDeferred<unknown>();
    f.invoke.mockImplementationOnce(() => gate.promise);
    const { done, onHost } = await f.watch();
    expect((await f.begin())[0]).toMatchObject({ sessions: [], pending: true });
    await advance();
    onHost.mockClear();
    if (revision === "failure") {
      gate.reject(new Error("Source unavailable"));
      await advance();
      await done();
      expect(onHost).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessions: [],
          error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
        }),
      );
      f.invoke.mockResolvedValue({ sessions: [] });
      await f.expectSessions([]);
      return;
    }
    if (revision === "config") {
      f.configure({ gateway: { port: 12345 } });
    } else {
      f.list.mockResolvedValue({
        nodes: [{ ...makeNode("alpha"), connected: revision !== "disconnect", connectedAtMs: 2 }],
      });
    }
    const host = (await f.begin())[0];
    expect(host?.sessions).toEqual([]);
    gate.resolve({ sessions: [{ ...nativeSession, name: "Retired publication" }] });
    await done();
    expect(onHost).not.toHaveBeenCalled();
    if (revision !== "disconnect") {
      await advance();
      await f.expectSessions();
    } else {
      expect(host?.error?.code).toBe("NODE_OFFLINE");
    }
  },
);

it.each(["viewer", "service"])("retires the %s without leaking publications", async (owner) => {
  const service = owner === "service";
  const gate = createDeferred<unknown>();
  f.invoke.mockImplementation(() => gate.promise);
  const controller = new AbortController();
  const { done, onHost } = await f.watch(service ? {} : { signal: controller.signal });
  onHost.mockClear();
  await advance();
  let stopped = false;
  const stopping = service
    ? f.stop().then(() => {
        stopped = true;
      })
    : undefined;
  if (service) {
    await done();
    expect(stopped).toBe(false);
  } else {
    controller.abort();
  }
  expect(f.invoke.mock.calls[0]?.[0].signal?.aborted).toBe(service);
  gate.resolve({ sessions: [nativeSession] });
  await stopping;
  await done();
  expect(onHost).not.toHaveBeenCalled();
  await f.expectSessions(service ? [] : [nativeSession]);
});

it("stops a multi-host publication when its catalog owner retires", async () => {
  f.nodes("alpha", "beta");
  const controller = new AbortController();
  const reason = new Error("catalog owner retired");
  const onHost = vi.fn(() => controller.abort(reason));
  await expect(f.readList({ signal: controller.signal, onHost })).rejects.toBe(reason);
  expect(onHost).toHaveBeenCalledTimes(1);
});

it("does not start catalog work after cancellation during node discovery", async () => {
  const gate = createDeferred<Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>>();
  const controller = new AbortController();
  const listing = f.readList({
    signal: controller.signal,
    listNodes: () => gate.promise,
  });
  const reason = new Error("viewer retired");
  controller.abort(reason);
  gate.resolve({ nodes: [] });
  await expect(listing).rejects.toBe(reason);
  expect(f.invoke).not.toHaveBeenCalled();
});

it.each([
  "known error",
  "unknown error",
  "level disabled",
  "disabled before settlement",
  "sink throws",
  "fast",
])("preserves refresh results with private-safe diagnostics: %s", async (mode) => {
  const rejected = mode.endsWith("error");
  const known = mode === "known error";
  diagnostics.enabled = true;
  diagnostics.warnEnabled = mode !== "level disabled";
  if (rejected) {
    f.nodes("alpha", "beta");
  }
  if (mode === "sink throws") {
    diagnostics.warn.mockImplementation(() => {
      throw new Error("diagnostic sink failed");
    });
  }
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const gate = createDeferred<void>();
  const invoke = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation((request) => gate.promise.then(() => invoke(request)));
  await f.hydrate();
  clock = rejected ? 30_000 : mode === "fast" ? 999 : 1_200;
  diagnostics.enabled = mode !== "disabled before settlement";
  if (rejected) {
    gate.reject(
      Object.assign(new Error("PRIVATE_MESSAGE"), {
        name: "GatewayClientRequestError",
        gatewayCode: known ? "UNAVAILABLE" : "PRIVATE_CODE",
        details: {
          nodeCommandDispatched: known ? false : undefined,
          nodeError: { code: known ? "TIMEOUT" : "PRIVATE_CODE", message: "PRIVATE_MESSAGE" },
          nodeId: "PRIVATE_NODE",
          params: { searchTerm: "PRIVATE_SEARCH" },
        },
      }),
    );
  } else {
    gate.resolve();
  }
  await advance(1);
  if (rejected) {
    expect(await f.host()).toMatchObject({ sessions: [], error: { code: "NODE_INVOKE_FAILED" } });
    expect(diagnostics.warn).toHaveBeenCalledExactlyOnceWith("slow Session Share catalog refresh", {
      elapsedMs: 30_000,
      outcome: "rejected",
      nodeErrorCode: known ? "TIMEOUT" : "unknown",
      ...(known ? { nodeCommandDispatched: false } : {}),
    });
  } else {
    await f.expectSessions();
    expect(diagnostics.warn).toHaveBeenCalledTimes(mode === "sink throws" ? 1 : 0);
  }
});

it("namespaces colliding claims by the invoked node, not the wire domain", async () => {
  f.nodes("alpha", "beta");
  const identity = {
    type: "remote" as const,
    pluginId: "session-share",
    domain: "node:alpha",
    idKind: "profile",
    id: "same-profile",
  };
  f.invoke.mockImplementation(async ({ command }) =>
    wire(
      command === commands[0]
        ? { sessions: [{ ...nativeSession, createdActor: { type: "human", identity } }] }
        : transcript({ sender: { identity } }),
    ),
  );
  await f.hydrate();
  const hosts = await f.readList({});
  const pages = await Promise.all(hosts.map(({ hostId }) => f.read(hostId)));
  const expected = [
    { ...identity, domain: "node:alpha" },
    { ...identity, domain: "node:beta" },
  ];
  expect.soft(hosts.map((host) => host.sessions[0]?.createdActor?.identity)).toEqual(expected);
  expect(pages.map((page) => page.items[0]?.sender?.identity)).toEqual(expected);
});

it("preserves eligible host order and separates offline and failed sources", async () => {
  f.list.mockResolvedValue({
    nodes: [
      { ...makeNode("partial"), commands: [commands[0]!] },
      { ...makeNode("offline"), displayName: "Bravo", connected: false },
      { ...makeNode("broken"), displayName: "Charlie" },
      { ...makeNode("alpha"), displayName: "Alpha" },
    ],
  });
  f.invoke.mockImplementation(async ({ nodeId }) => {
    if (nodeId === "broken") {
      throw new Error("disconnected");
    }
    return { sessions: [nativeSession] };
  });
  await f.hydrate();
  const hosts = await f.readList({});
  expect(hosts).toMatchObject([
    { hostId: "node:alpha" },
    { hostId: "node:offline", error: { code: "NODE_OFFLINE" } },
    { hostId: "node:broken", error: { code: "NODE_INVOKE_FAILED" } },
  ]);
  expect(hosts[0]?.sessions).toEqual([nativeSession]);
  expect(f.invoke).toHaveBeenCalledTimes(4);
  expect(f.catalog.continueSession).toBeUndefined();
  expect(f.catalog.archive).toBeUndefined();
  expect(f.catalog.openTerminal).toBeUndefined();
});

it.each([
  { ...makeNode("alpha"), connected: false },
  { ...makeNode("alpha"), commands: [commands[0]!] },
])("denies reads when the paired host is unavailable: %j", async (node) => {
  f.list.mockResolvedValue({ nodes: [node] });
  await expect(f.read()).rejects.toThrow("unavailable");
  expect(f.invoke).not.toHaveBeenCalled();
});

it.each([
  ["session", { createdActor: { type: "human", identity: { type: "profile", id: "forged" } } }],
  ["session", { sessionKey: "agent:main:local" }],
  ["session", { canContinue: true }],
  ["transcript", { sender: { identity: { type: "profile", id: "forged" } } }],
  ["transcript", { unexpected: true }],
] as const)("rejects forbidden %s fields: %j", async (kind, patch) => {
  const payload =
    kind === "session" ? { sessions: [{ ...nativeSession, ...patch }] } : transcript(patch);
  f.invoke.mockResolvedValue(wire(payload));
  if (kind === "session") {
    await f.hydrate();
    expect(await f.host()).toMatchObject({ sessions: [], error: { code: "NODE_INVOKE_FAILED" } });
  } else {
    await expect(f.read()).rejects.toThrow("Invalid OpenClaw transcript");
  }
});
