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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionShareCatalog } from "./session-catalog.js";
import type { SessionCatalogSourceProfileRelation } from "./wire.js";

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
    expect(waiting[0]?.error?.code).toBe("CATALOG_CAPACITY");
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
  await vi.advanceTimersByTimeAsync(30_005);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  const retry = createDeferred<unknown>();
  f.invoke.mockImplementationOnce(() => retry.promise);
  await vi.advanceTimersByTimeAsync(30_005);
  expect(f.invoke).toHaveBeenCalledTimes(3);
  // A live consumer joins the pending retry without resetting its backoff.
  await f.begin();
  retry.reject(new Error("offline"));
  await vi.advanceTimersByTimeAsync(2);
  const wallNow = Date.now();
  vi.setSystemTime(wallNow - 86_400_000);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(f.invoke).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1_005);
  expect(f.invoke).toHaveBeenCalledTimes(4);
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

describe("caller-scoped relationship polling", () => {
  const involving: SessionCatalogSourceProfileRelation = {
    relationship: "involving",
    target: { type: "github-account", id: "101" },
  };
  const owned: SessionCatalogSourceProfileRelation = {
    relationship: "owned",
    target: { type: "profile", id: "source-person" },
  };

  it("pulls only each query's source pages and retains all three independent pollers", async () => {
    f.invoke.mockImplementation(async ({ params }) => {
      const request = params as {
        cursor?: string;
        profileRelation?: SessionCatalogSourceProfileRelation;
      };
      const cohort = request.profileRelation?.relationship ?? "unfiltered";
      const selected = rows(cohort === "involving" ? 101 : 1);
      for (const row of selected) {
        row.name = cohort;
      }
      const offset = decodeCursor(request.cursor, request.profileRelation);
      return wire({
        sessions: selected.slice(offset, offset + 100),
        ...(offset + 100 < selected.length
          ? { nextCursor: encodeCursor(offset + 100, request.profileRelation) }
          : {}),
      });
    });
    const a = { caller: { id: "a" }, profileRelation: involving };
    const b = { caller: { id: "b" }, profileRelation: owned };
    const first = await f.host({ ...a, limitPerHost: 100 });
    expect(first?.sessions).toHaveLength(100);
    expect(f.invoke.mock.calls.map(([request]) => request.params)).toEqual([
      { limit: 100, profileRelation: involving },
      { limit: 100, profileRelation: involving, cursor: encodeCursor(100, involving) },
    ]);
    const last = await f.host({ ...a, cursors: { "node:alpha": first!.nextCursor! } });
    expect(last?.sessions).toHaveLength(1);
    expect((await f.host(b))?.sessions[0]?.name).toBe("owned");
    expect((await f.host({ caller: { id: "c" } }))?.sessions[0]?.name).toBe("unfiltered");
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    const queries = f.invoke.mock.calls.map(
      ([request]) =>
        (request.params as { profileRelation?: SessionCatalogSourceProfileRelation })
          .profileRelation,
    );
    expect(queries).toContainEqual(involving);
    expect(queries).toContainEqual(owned);
    expect(queries).toContain(undefined);
  });

  it("keeps independent queries on one connection when another polling scope changes", async () => {
    f.invoke.mockImplementation(async ({ params }) => {
      const query = (params as { profileRelation?: SessionCatalogSourceProfileRelation })
        .profileRelation;
      return wire({ sessions: [{ ...nativeSession, name: query?.relationship ?? "unfiltered" }] });
    });
    const intent = new AbortController();
    const sidebar = {
      caller: { id: "same", pollId: "sidebar", pollSignal: intent.signal },
      profileRelation: involving,
    };
    const pane = { caller: { id: "same", pollId: "pane" }, profileRelation: involving };
    const lookup = { caller: { id: "same" } };
    await f.host(sidebar);
    await f.host(pane);
    await f.host(lookup);
    intent.abort();
    const replacement = {
      ...sidebar,
      caller: { ...sidebar.caller, pollSignal: new AbortController().signal },
      profileRelation: owned,
    };
    expect((await f.host(replacement))?.sessions[0]?.name).toBe("owned");
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    const queries = f.invoke.mock.calls.map(
      ([request]) =>
        (request.params as { profileRelation?: SessionCatalogSourceProfileRelation })
          .profileRelation,
    );
    expect(queries).toHaveLength(3);
    expect(queries).toContainEqual(involving);
    expect(queries).toContainEqual(owned);
    expect(queries).toContain(undefined);
  });

  it("publishes interleaved held queries on one connection independently", async () => {
    const held = {
      involving: createDeferred<unknown>(),
      owned: createDeferred<unknown>(),
      unfiltered: createDeferred<unknown>(),
    };
    f.invoke.mockImplementation(({ params }) => {
      const relation = (params as { profileRelation?: SessionCatalogSourceProfileRelation })
        .profileRelation;
      return held[relation?.relationship ?? "unfiltered"].promise;
    });
    const caller = { id: "same-connection" };
    const publications = {
      involving: await f.watch({ caller, profileRelation: involving }),
      owned: await f.watch({ caller, profileRelation: owned }),
      unfiltered: await f.watch({ caller }),
    };
    try {
      await vi.advanceTimersByTimeAsync(2);
      expect(f.invoke).toHaveBeenCalledTimes(3);
      for (const cohort of ["owned", "unfiltered", "involving"] as const) {
        held[cohort].resolve(wire({ sessions: [{ ...nativeSession, name: cohort }] }));
        await vi.advanceTimersByTimeAsync(2);
        await publications[cohort].done();
        expect(publications[cohort].onHost).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessions: [expect.objectContaining({ name: cohort })],
          }),
        );
      }
      for (const cohort of ["owned", "unfiltered", "involving"] as const) {
        const published = publications[cohort].onHost.mock.calls.flatMap(([host]) => host.sessions);
        expect(published.map(({ name }) => name)).toEqual([cohort]);
      }
    } finally {
      for (const gate of Object.values(held)) {
        gate.resolve(wire({ sessions: [] }));
      }
    }
  });

  it("admits another caller after the first fills its snapshot allowance without cancelling its polls", async () => {
    f.nodes(...Array.from({ length: 32 }, (_, index) => `node-${index}`));
    f.invoke.mockImplementation(async ({ params }) =>
      wire({
        sessions: [
          {
            ...nativeSession,
            name:
              (params as { profileRelation?: SessionCatalogSourceProfileRelation }).profileRelation
                ?.relationship ?? "unfiltered",
          },
        ],
      }),
    );
    const a = { caller: { id: "capacity-a", pollId: "sidebar" }, profileRelation: involving };
    expect(await f.readList(a)).toHaveLength(32);
    const b = {
      caller: { id: "capacity-b", pollId: "sidebar" },
      profileRelation: owned,
      hostIds: ["node:node-0"],
    };
    expect((await f.host(b))?.sessions[0]?.name).toBe("owned");
    const c = { caller: { id: "capacity-c", pollId: "sidebar" }, hostIds: ["node:node-0"] };
    expect((await f.host(c))?.sessions[0]?.name).toBe("unfiltered");
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    const polls = f.invoke.mock.calls.map(
      ([request]) => request.params as { profileRelation?: SessionCatalogSourceProfileRelation },
    );
    expect(
      polls.filter(({ profileRelation }) => profileRelation?.relationship === "involving"),
    ).toHaveLength(32);
    expect(
      polls.filter(({ profileRelation }) => profileRelation?.relationship === "owned"),
    ).toHaveLength(1);
    expect(polls.filter(({ profileRelation }) => profileRelation === undefined)).toHaveLength(1);
    expect((await f.host({ ...a, hostIds: ["node:node-0"] }))?.sessions[0]?.name).toBe("involving");
  });

  it("does not treat one caller's node inventory as another caller's withdrawal", async () => {
    f.nodes("alpha", "beta");
    const intent = new AbortController();
    await f.host({
      caller: { id: "a", pollId: "sidebar", pollSignal: intent.signal },
      profileRelation: involving,
      listNodes: async () => ({ nodes: [makeNode("alpha")] }),
    });
    await f.host({
      caller: { id: "b", pollId: "sidebar" },
      profileRelation: owned,
      listNodes: async () => ({ nodes: [makeNode("beta")] }),
    });
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.invoke.mock.calls.map(([request]) => [request.nodeId, request.params])).toEqual(
      expect.arrayContaining([
        ["alpha", { limit: 100, profileRelation: involving }],
        ["beta", { limit: 100, profileRelation: owned }],
      ]),
    );
    // Changing A's selection while no node is visible retires A's old polling,
    // not B's node. The service still sees both connections as live.
    intent.abort();
    await f.readList({
      caller: { id: "a", pollId: "sidebar", pollSignal: new AbortController().signal },
      profileRelation: owned,
      listNodes: async () => ({ nodes: [] }),
    });
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.invoke.mock.calls.map(([request]) => request.nodeId)).toEqual(["beta"]);
  });

  it("retires changed and disconnected caller queries without publishing late bytes or cancelling peers", async () => {
    const controller = new AbortController();
    const intent = new AbortController();
    const a = {
      caller: { id: "a", pollId: "sidebar", signal: controller.signal, pollSignal: intent.signal },
      profileRelation: involving,
    };
    const b = { caller: { id: "b" }, profileRelation: owned };
    await f.host(b);
    const held = createDeferred<unknown>();
    f.invoke.mockImplementation(async ({ params }) =>
      (params as { profileRelation?: SessionCatalogSourceProfileRelation }).profileRelation
        ?.relationship === "involving"
        ? held.promise
        : wire({ sessions: [{ ...nativeSession, name: "current" }] }),
    );
    const old = await f.watch(a);
    await vi.advanceTimersByTimeAsync(1);
    intent.abort();
    const changed = await f.host({
      ...a,
      caller: { ...a.caller, pollSignal: new AbortController().signal },
      profileRelation: owned,
    });
    expect(changed?.sessions[0]?.name).toBe("current");
    held.resolve(wire({ sessions: [{ ...nativeSession, name: "obsolete" }] }));
    await old.done();
    expect(JSON.stringify(old.onHost.mock.calls)).not.toContain("obsolete");
    controller.abort();
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.invoke.mock.calls).toHaveLength(1);
    expect(f.invoke.mock.calls[0]?.[0].params).toMatchObject({ profileRelation: owned });
  });

  it("does not admit a superseded query after held node discovery", async () => {
    const discovery = createDeferred<{ nodes: ReturnType<typeof makeNode>[] }>();
    const intent = new AbortController();
    const old = f.catalog.list({
      caller: { id: "one", pollId: "sidebar", pollSignal: intent.signal },
      profileRelation: involving,
      listNodes: () => discovery.promise,
    });
    void old.catch(() => {});
    intent.abort();
    await f.host({
      caller: { id: "one", pollId: "sidebar", pollSignal: new AbortController().signal },
      profileRelation: owned,
    });
    discovery.resolve({ nodes: [makeNode("alpha")] });
    await expect(old).rejects.toThrow();
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.invoke.mock.calls.map(([request]) => request.params)).toEqual([
      { limit: 100, profileRelation: owned },
    ]);
  });

  it("stops an old unfiltered poll when replacement intent fails before provider admission", async () => {
    const intent = new AbortController();
    await f.host({ caller: { id: "one", pollId: "sidebar", pollSignal: intent.signal } });
    await f.host({ caller: { id: "peer" }, profileRelation: owned });
    // Gateway resolution rejects the new selection, so no replacement list is made.
    intent.abort();
    f.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(f.invoke.mock.calls.map(([request]) => request.params)).toEqual([
      { limit: 100, profileRelation: owned },
    ]);
  });

  it("bounds aggregate queues across many callers and reclaims idle consumers without cancelling running work", async () => {
    const held = createDeferred<unknown>();
    const dispatched: AbortSignal[] = [];
    const publications = Array.from({ length: 64 }, () => vi.fn());
    f.invoke.mockImplementation(async ({ signal }) => {
      dispatched.push(signal!);
      return held.promise;
    });
    try {
      for (let index = 0; index < 64; index++) {
        await f.begin({
          caller: { id: `caller-${index}` },
          onHost: publications[index],
          profileRelation: index % 2 ? owned : involving,
        });
      }
      await vi.advanceTimersByTimeAsync(2);
      expect(f.invoke).toHaveBeenCalledTimes(4);
      for (let index = 64; index < 80; index++) {
        expect((await f.begin({ caller: { id: `caller-${index}` } }))[0]?.error?.code).toBe(
          "CATALOG_CAPACITY",
        );
      }
      expect(dispatched.every((signal) => !signal.aborted)).toBe(true);
      held.resolve(wire({ sessions: [nativeSession] }));
      await vi.advanceTimersByTimeAsync(2);
      expect(f.invoke).toHaveBeenCalledTimes(64);
      for (const published of publications) {
        expect(published).toHaveBeenCalledWith(
          expect.objectContaining({ sessions: [nativeSession] }),
        );
      }
      expect(dispatched.every((signal) => !signal.aborted)).toBe(true);
      // Unconsumed scopes expire even while their connection stays open. A new peer
      // can then make progress; old queued requests were not retained beyond the cap.
      await vi.advanceTimersByTimeAsync(120_010);
      f.invoke.mockClear();
      expect(
        (await f.host({ caller: { id: "new-peer" }, profileRelation: owned }))?.sessions,
      ).toEqual([nativeSession]);
      expect(f.invoke).toHaveBeenCalledTimes(1);
      f.invoke.mockClear();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(f.invoke.mock.calls.map(([request]) => request.params)).toEqual([
        { limit: 100, profileRelation: owned },
      ]);
    } finally {
      held.resolve(wire({ sessions: [] }));
    }
  });
});
