import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
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
    .mockImplementation(async ({ command }) =>
      command === commands[0]
        ? { payloadJSON: JSON.stringify({ sessions: [nativeSession] }) }
        : {
            payloadJSON: JSON.stringify({
              threadId: nativeSession.threadId,
              items: [{ type: "userMessage", text: "Published question" }],
            }),
          },
    );
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  let service: OpenClawPluginService | undefined;
  const api = createTestPluginApi({
    runtime,
    registerService: (registered) => {
      service = registered;
    },
  });
  const catalog = createSessionShareCatalog(api);
  const serviceContext = { config, logger: api.logger, stateDir: "/unused", invokeNode: invoke };
  await service?.start(serviceContext);
  return {
    catalog,
    list,
    invoke,
    stop: async () => service?.stop?.(serviceContext),
    configure: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

describe("session-share receiver catalog", () => {
  it.each([
    [
      "agent:research:dashboard:01234567-89ab-cdef-0123-456789abcdef",
      "/chat/research/dashboard/01234567-89ab-cdef-0123-456789abcdef",
    ],
    ["agent:research:shared", "/chat/research/shared"],
    ["agent:research:global", "/chat/research/~key/global"],
    ["session-share:research:global", "/chat/research"],
    ["global", undefined],
  ])("builds source-owned links for %s and withdraws them on reload", async (threadId, path) => {
    const fixture = await catalogFixture();
    fixture.invoke.mockResolvedValue({ sessions: [{ ...nativeSession, threadId }] });
    expect((await fixture.catalog.list({}))[0]?.sessions[0]?.originalUrl).toBeUndefined();
    fixture.configure({
      plugins: {
        entries: {
          "session-share": {
            config: {
              nodes: { alpha: { controlUiOrigin: "https://team.example.com/" } },
            },
          },
        },
      },
    });
    const row = (await fixture.catalog.list({}))[0]?.sessions[0];
    expect(row?.originalUrl).toBe(path ? `https://team.example.com${path}` : undefined);
    expect(row?.canContinue).toBe(false);
    fixture.configure({});
    expect((await fixture.catalog.list({}))[0]?.sessions[0]?.originalUrl).toBeUndefined();
  });

  it.each([
    "javascript:alert(1)",
    "//team.example.com",
    "https://user:secret@team.example.com",
    "https://team.example.com/path",
    "https://team.example.com/..",
    "https://team.example.com?token=secret",
    "https://team.example.com#token",
    "https://team.example.com?",
    "https://team.example.com#",
    "https://team.example.com\\evil",
    "https://team.example.com\n",
    "https:team.example.com",
    "https://[",
  ])(
    "does not publish an original link for invalid receiver origin %j",
    async (controlUiOrigin) => {
      const fixture = await catalogFixture();
      fixture.configure({
        plugins: {
          entries: {
            "session-share": {
              config: {
                nodes: { alpha: { controlUiOrigin } },
              },
            },
          },
        },
      });
      const row = (await fixture.catalog.list({}))[0]?.sessions[0];
      expect(row?.threadId).toBe(nativeSession.threadId);
      expect(row?.originalUrl).toBeUndefined();
    },
  );

  it("rejects source-supplied original URLs instead of trusting remote navigation", async () => {
    const fixture = await catalogFixture();
    fixture.invoke.mockResolvedValue({
      sessions: [{ ...nativeSession, originalUrl: "https://evil.example" }],
    });
    const host = (await fixture.catalog.list({}))[0];
    expect(host?.sessions).toEqual([]);
    expect(host?.error?.code).toBe("NODE_INVOKE_FAILED");
  });

  it("serves complete lookups during cache saturation without losing active publications", async () => {
    vi.useFakeTimers();
    const fixture = await catalogFixture();
    const gate = createDeferred<unknown>();
    fixture.list.mockResolvedValue({
      nodes: Array.from({ length: 32 }, (_, index) => ({
        nodeId: `node-${index}`,
        connected: true,
        commands,
      })),
    });
    fixture.invoke.mockImplementation(() => gate.promise);
    const onHost = vi.fn();
    const publications: Promise<void>[] = [];
    try {
      const listing = fixture.catalog.list({
        allowPartialResults: true,
        onHost,
        waitUntil: (work) => publications.push(work),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await listing).toHaveLength(32);
      const selected = fixture.catalog.list({ hostIds: ["node:node-0"], limitPerHost: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.invoke).toHaveBeenCalledTimes(33);
      gate.resolve({ sessions: [nativeSession] });
      expect((await selected)[0]).toMatchObject({ sessions: [nativeSession] });
      await Promise.all(publications);
      expect(onHost.mock.calls.filter(([host]) => host.sessions.length === 1)).toHaveLength(32);
    } finally {
      gate.resolve({ sessions: [] });
      await vi.runAllTimersAsync();
      await fixture.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "cold default", query: {}, warm: false },
    { label: "warm default", query: {}, warm: true },
    { label: "explicit complete", query: { allowPartialResults: false }, warm: false },
    { label: "unsubscribed opt-in", query: { allowPartialResults: true }, warm: false },
    { label: "targeted", query: { hostIds: ["node:alpha"] }, warm: false },
    {
      label: "cursor",
      query: { cursors: { "node:alpha": sessionCatalogPaging.encodeCursor(20) } },
      warm: false,
    },
  ])("returns complete snapshots for $label callers", async ({ query, warm }) => {
    vi.useFakeTimers();
    const fixture = await catalogFixture();
    try {
      if (warm) {
        await fixture.catalog.list(query);
      }
      const refreshed = { ...nativeSession, name: "Complete refresh" };
      fixture.invoke.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 6_000);
        });
        return { sessions: [refreshed] };
      });
      let settled = 0;
      const calls = Array.from({ length: 6 }, () =>
        fixture.catalog.list(query).then((hosts) => {
          settled++;
          return hosts;
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      for (const hosts of await Promise.all(calls)) {
        expect(hosts[0]).toMatchObject({ sessions: [refreshed] });
        expect(hosts[0]?.pending).toBeUndefined();
        expect(hosts[0]?.error).toBeUndefined();
      }
      expect(fixture.invoke).toHaveBeenCalledTimes(warm ? 2 : 1);
    } finally {
      await vi.runAllTimersAsync();
      await fixture.stop();
      vi.useRealTimers();
    }
  });

  it.each(["success", "failure"])(
    "bounds a six-caller cold burst through a slow node %s",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const fixture = await catalogFixture();
        fixture.invoke.mockImplementation(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 30_000);
          });
          if (outcome === "failure") {
            throw new Error("node timeout");
          }
          return { sessions: [nativeSession] };
        });
        const started = Date.now();
        const elapsed: number[] = [];
        const publications: Promise<void>[] = [];
        const updates = Array.from({ length: 6 }, () => vi.fn());
        const pending = updates.map((onHost) =>
          fixture.catalog
            .list({
              allowPartialResults: true,
              onHost,
              waitUntil: (work) => publications.push(work),
            })
            .then((hosts) => {
              elapsed.push(Date.now() - started);
              return hosts;
            }),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await Promise.all(pending);
        await Promise.all(publications);
        console.log(
          JSON.stringify({
            p99Ms: Math.max(...elapsed),
            invocations: fixture.invoke.mock.calls.length,
          }),
        );
        expect(Math.max(...elapsed)).toBeLessThanOrEqual(5_000);
        expect(fixture.invoke).toHaveBeenCalledTimes(1);
        for (const update of updates) {
          expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ pending: true }));
          expect(update).toHaveBeenLastCalledWith(
            expect.objectContaining(
              outcome === "success"
                ? { sessions: [nativeSession] }
                : {
                    sessions: [],
                    error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
                  },
            ),
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["unchanged", "config", "connection", "query"])(
    "retains only a compatible page during %s refresh",
    async (revision) => {
      const fixture = await catalogFixture();
      await fixture.catalog.list({});
      const refreshed = { ...nativeSession, name: "Refreshed" };
      const gate = createDeferred<unknown>();
      fixture.invoke.mockImplementation(() => gate.promise);
      if (revision === "config") {
        fixture.configure({ gateway: { port: 12345 } });
      }
      if (revision === "connection") {
        fixture.list.mockResolvedValue({
          nodes: [{ nodeId: "alpha", connected: true, connectedAtMs: 2, commands }],
        });
      }
      vi.useFakeTimers();
      try {
        const onHost = vi.fn();
        const publications: Promise<void>[] = [];
        const pending = fixture.catalog.list({
          allowPartialResults: true,
          search: revision === "query" ? "new" : undefined,
          onHost,
          waitUntil: (work) => publications.push(work),
        });
        await vi.advanceTimersByTimeAsync(5_000);
        const hosts = await pending;
        expect(hosts).toEqual([
          expect.objectContaining({
            pending: true,
            sessions: revision === "unchanged" ? [nativeSession] : [],
          }),
        ]);
        gate.resolve({ sessions: [refreshed] });
        await Promise.all(publications);
        expect(onHost).toHaveBeenLastCalledWith(expect.objectContaining({ sessions: [refreshed] }));
        expect(fixture.invoke).toHaveBeenCalledTimes(2);
      } finally {
        gate.resolve({ sessions: [] });
        await fixture.stop();
        vi.useRealTimers();
      }
    },
  );

  it("shares matching queries without reusing a caller's cancellation", async () => {
    const fixture = await catalogFixture();
    const gate = createDeferred<unknown>();
    fixture.invoke.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    const onHost = vi.fn();
    const publications: Promise<void>[] = [];
    const original = fixture.catalog.list({ signal: controller.signal, onHost });
    const other = fixture.catalog.list({
      search: "other",
      waitUntil: (work) => publications.push(work),
    });
    const follower = fixture.catalog.list({
      allowPartialResults: true,
      onHost: vi.fn(),
      waitUntil: (work) => publications.push(work),
    });
    await follower;
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    controller.abort(new Error("caller retired"));
    const rejected = expect(original).rejects.toThrow("caller retired");
    gate.resolve({ sessions: [nativeSession] });
    await rejected;
    expect((await other)[0]?.sessions).toEqual([nativeSession]);
    await Promise.all(publications);
    expect(onHost).not.toHaveBeenCalled();
  });

  describe("slow phase diagnostics", () => {
    beforeEach(() => {
      diagnostics.enabled = true;
      diagnostics.warnEnabled = true;
      diagnostics.warn.mockReset();
    });
    afterEach(() => {
      diagnostics.enabled = false;
      vi.restoreAllMocks();
    });

    it.each([true, false, undefined])(
      "preserves timeout dispatch attribution (%s) without private error data",
      async (nodeCommandDispatched) => {
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const fixture = await catalogFixture();
        const list = fixture.list.getMockImplementation()!;
        fixture.list.mockImplementation(async (params) => {
          clock += 1_200;
          return list(params);
        });
        fixture.invoke.mockImplementation(async () => {
          clock += 30_000;
          throw Object.assign(new Error("PRIVATE_MESSAGE"), {
            name: "GatewayClientRequestError",
            gatewayCode: nodeCommandDispatched === undefined ? "PRIVATE_CODE" : "UNAVAILABLE",
            retryable: false,
            details: {
              nodeCommandDispatched,
              nodeError: {
                code: nodeCommandDispatched === undefined ? "PRIVATE_CODE" : "TIMEOUT",
                message: "PRIVATE_MESSAGE",
              },
              nodeId: "PRIVATE_NODE",
              params: { searchTerm: "PRIVATE_SEARCH" },
            },
          });
        });

        const onHost = vi.fn();
        const publications: Promise<void>[] = [];
        await fixture.catalog.list({ onHost, waitUntil: (work) => publications.push(work) });
        await Promise.all(publications);
        expect(onHost).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sessions: [],
            error: expect.objectContaining({ code: "NODE_INVOKE_FAILED" }),
          }),
        );
        expect(diagnostics.warn.mock.calls).toEqual([
          [
            "slow Session Share catalog phase",
            { phase: "discovery", elapsedMs: 1_200, outcome: "resolved" },
          ],
          [
            "slow Session Share catalog phase",
            {
              phase: "invoke",
              elapsedMs: 30_000,
              outcome: "rejected",
              nodeErrorCode: nodeCommandDispatched === undefined ? "unknown" : "TIMEOUT",
              ...(nodeCommandDispatched !== undefined ? { nodeCommandDispatched } : {}),
            },
          ],
        ]);
      },
    );

    it.each(["disabled", "level disabled", "disabled before settlement", "sink throws", "fast"])(
      "preserves successful listings when diagnostics are %s",
      async (mode) => {
        diagnostics.enabled = mode !== "disabled";
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

        const hosts = await fixture.catalog.list({});
        expect(hosts[0]?.sessions).toEqual([nativeSession]);
        expect(diagnostics.warn).toHaveBeenCalledTimes(mode === "sink throws" ? 1 : 0);
      },
    );
  });

  it("does not invoke nodes when the owner retires during discovery", async () => {
    const fixture = await catalogFixture();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const controller = new AbortController();
    const original = fixture.list.getMockImplementation()!;
    fixture.list.mockImplementation(async (query) => {
      entered.resolve();
      await release.promise;
      return original(query);
    });
    const pending = fixture.catalog.list({ signal: controller.signal });
    await entered.promise;
    const reason = new Error("catalog owner retired");
    controller.abort(reason);
    release.resolve();
    await expect(pending).rejects.toBe(reason);

    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it("delivers service retirement to an active shared node invocation", async () => {
    const fixture = await catalogFixture();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const controller = new AbortController();
    let transportRetired = false;
    fixture.invoke.mockImplementation(async ({ signal }) => {
      const retire = () => {
        transportRetired = true;
        release.resolve();
      };
      signal?.addEventListener("abort", retire, { once: true });
      entered.resolve();
      try {
        await release.promise;
        return { sessions: [] };
      } finally {
        signal?.removeEventListener("abort", retire);
      }
    });
    const pending = fixture.catalog.list({ signal: controller.signal });
    try {
      await entered.promise;
      await fixture.stop();
      expect(transportRetired).toBe(true);
    } finally {
      release.resolve();
      await pending.catch(() => []);
    }
  });

  it.each(["retirement", "publication failure"] as const)(
    "joins all started node work before rejecting on %s",
    async (failure) => {
      const fixture = await catalogFixture();
      const entered = createDeferred<void>();
      const fast = createDeferred<void>();
      const slow = createDeferred<void>();
      const reason = new Error(failure);
      const controller = new AbortController();
      fixture.list.mockResolvedValue({
        nodes: ["fast", "slow"].map((nodeId) => ({ nodeId, connected: true, commands })),
      });
      let started = 0;
      fixture.invoke.mockImplementation(async ({ nodeId }) => {
        if (++started === 2) {
          entered.resolve();
        }
        await (nodeId === "fast" ? fast.promise : slow.promise);
        return { sessions: [] };
      });
      const onHost = vi.fn((host: { hostId: string }) => {
        if (failure === "publication failure" && host.hostId === "node:fast") {
          throw reason;
        }
      });
      let settled = false;
      const pending = fixture.catalog.list({ signal: controller.signal, onHost });
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await entered.promise;
        if (failure === "retirement") {
          controller.abort(reason);
        }
        fast.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        if (failure === "retirement") {
          expect(onHost).not.toHaveBeenCalled();
        }
        slow.resolve();
        await expect(pending).rejects.toBe(reason);
      } finally {
        fast.resolve();
        slow.resolve();
        await pending.catch(() => []);
      }
    },
  );

  it.each(["openclaw", "node:alpha"])(
    "namespaces colliding profile claims by the invoked node, not wire domain %s",
    async (domain) => {
      const fixture = await catalogFixture();
      fixture.list.mockResolvedValue({
        nodes: ["alpha", "beta"].map((nodeId) => ({ nodeId, commands, connected: true })),
      });
      const identity = { ...remoteIdentity, domain, idKind: "profile", id: "same-profile" };
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
      const hosts = await fixture.catalog.list({});
      const pages = await Promise.all(
        hosts.map(({ hostId }) =>
          fixture.catalog.read({ hostId, threadId: nativeSession.threadId }),
        ),
      );
      const expected = [
        { ...identity, domain: "node:alpha" },
        { ...identity, domain: "node:beta" },
      ];
      expect.soft(hosts.map((host) => host.sessions[0]?.createdActor?.identity)).toEqual(expected);
      expect(pages.map((page) => page.items[0]?.sender?.identity)).toEqual(expected);
    },
  );

  it("publishes eligible hosts progressively, preserving failures and deterministic host order", async () => {
    const fixture = await catalogFixture();
    const slow = createDeferred<unknown>();
    fixture.list.mockResolvedValue({
      nodes: [
        { nodeId: "slow", displayName: "Zulu", commands, connected: true },
        { nodeId: "partial", displayName: "Partial", commands: [commands[0]!], connected: true },
        { nodeId: "offline", displayName: "Bravo", commands, connected: false },
        { nodeId: "broken", displayName: "Charlie", commands, connected: true },
        { nodeId: "alpha", displayName: "Alpha", commands, connected: true },
      ],
    });
    fixture.invoke.mockImplementation(async ({ nodeId }) => {
      if (nodeId === "slow") {
        return slow.promise;
      }
      if (nodeId === "broken") {
        throw new Error("disconnected");
      }
      return { sessions: [nativeSession] };
    });
    const onHost = vi.fn();
    const pending = fixture.catalog.list({ onHost });
    await vi.waitFor(() => expect(onHost).toHaveBeenCalledTimes(3));
    expect(onHost.mock.calls.map(([host]) => host.hostId)).not.toContain("node:slow");
    slow.resolve({ sessions: [nativeSession] });
    const hosts = await pending;
    expect(hosts.map((host) => host.hostId)).toEqual([
      "node:alpha",
      "node:offline",
      "node:broken",
      "node:slow",
    ]);
    expect(hosts[1]?.error?.code).toBe("NODE_OFFLINE");
    expect(hosts[2]?.error?.code).toBe("NODE_INVOKE_FAILED");
    expect(onHost).toHaveBeenCalledTimes(4);
    expect(fixture.invoke.mock.calls.map(([request]) => request.nodeId).toSorted()).toEqual([
      "alpha",
      "broken",
      "slow",
    ]);
  });

  it("forwards filtered per-host pagination and uses the request-owned node snapshot", async () => {
    const fixture = await catalogFixture();
    const cursor = sessionCatalogPaging.encodeCursor(20);
    fixture.invoke.mockResolvedValue({
      sessions: [nativeSession],
      nextCursor: sessionCatalogPaging.encodeCursor(21),
    });
    const listNodes = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
      nodes: [
        { nodeId: "alpha", remoteIp: "127.0.0.2", commands, connected: true },
        { nodeId: "other", commands, connected: true },
      ],
    });
    const hosts = await fixture.catalog.list({
      hostIds: ["node:alpha"],
      search: "shared",
      limitPerHost: 3,
      cursors: { "node:alpha": cursor },
      listNodes,
    });
    expect(hosts).toEqual([
      expect.objectContaining({
        hostId: "node:alpha",
        label: "127.0.0.2",
        sessions: [nativeSession],
        nextCursor: sessionCatalogPaging.encodeCursor(21),
      }),
    ]);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.invoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nodeId: "alpha",
        command: commands[0],
        params: { searchTerm: "shared", limit: 3, cursor },
      }),
    );
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
    { label: "long label", patch: { createdActor: { type: "human", label: "x".repeat(201) } } },
    { label: "unknown field", patch: { unexpected: true } },
    { label: "local adoption", patch: { sessionKey: "agent:main:local" } },
    { label: "write capability", patch: { canContinue: true } },
  ])("rejects node rows carrying $label", async ({ patch }) => {
    const fixture = await catalogFixture();
    fixture.invoke.mockResolvedValue({
      payloadJSON: JSON.stringify({ sessions: [{ ...nativeSession, ...patch }] }),
    });
    const hosts = await fixture.catalog.list({});
    expect(hosts[0]).toMatchObject({ sessions: [], error: { code: "NODE_INVOKE_FAILED" } });
  });

  it.each([
    { sender: { identity: { type: "profile", id: "forged" } } },
    { sender: { identity: remoteIdentity, label: "x".repeat(201) } },
    { unexpected: true },
  ])("rejects transcript payload outside the closed wire identity contract: %j", async (patch) => {
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
  });
});
