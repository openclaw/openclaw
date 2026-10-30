import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  reloadSessionMcpRuntimes,
} from "./agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "./agent-bundle-mcp-manager.test-support.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRequesterScope, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { OpenClawStreamableHTTPClientTransport } from "./mcp-http-transport.js";
import { withMcpOAuthBearer } from "./mcp-oauth-fetch.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { saveMcpOAuthAccessTokenForTest } from "./mcp-oauth.test-support.js";
import * as mcpTransport from "./mcp-transport.js";
import { acquireNativeMcpServer } from "./native-mcp-runtime.js";

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));
vi.mock("../logger.js", () => ({ logWarn: warn }));
vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: ({ cfg }: { cfg: OpenClawConfig }) => ({
    mcpServers: cfg.mcp?.servers ?? {},
    diagnostics: [],
  }),
}));

const runtimes: SessionMcpRuntime[] = [];
const transports: OpenClawStreamableHTTPClientTransport[] = [];
let initializes = 0;
let remoteToolName = "probe";
let reachable = false;
let invalidListing = false;
let listToolsGate: Promise<void> | undefined;
let oauthRequired = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  transports.length = 0;
  initializes = 0;
  remoteToolName = "probe";
  reachable = false;
  invalidListing = false;
  listToolsGate = undefined;
  oauthRequired = false;
  warn.mockClear();
  vi.spyOn(mcpTransport, "resolveMcpTransport").mockImplementation((serverName: string) => {
    const fetchFixture = async (_input: string | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      if (oauthRequired && !new Headers(init.headers).has("authorization")) {
        initializes += 1;
        return new Response(null, { status: 401 });
      }
      const message = JSON.parse(await new Response(init.body).text()) as {
        id?: number;
        method: string;
      };
      if (message.method === "initialize") {
        initializes += 1;
        if (!reachable && serverName === "remote") {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject(new Error("Fixture request aborted", { cause: init.signal?.reason })),
              { once: true },
            );
          });
        }
      }
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/list" && serverName === "remote") {
        await listToolsGate;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "fixture", version: "1" },
              }
            : {
                tools: [
                  {
                    name: serverName === "remote" ? remoteToolName : "healthy_tool",
                    inputSchema:
                      invalidListing && serverName === "remote"
                        ? { type: "array", items: { type: "number" } }
                        : { type: "object" },
                  },
                ],
              },
      });
    };
    const transport = new OpenClawStreamableHTTPClientTransport(
      new URL("https://mcp.invalid/mcp"),
      {
        fetch: oauthRequired
          ? withMcpOAuthBearer({
              fetchFn: fetchFixture,
              authFetchFn: fetchFixture,
              identity: operatorMcpOAuthIdentity(serverName, "https://mcp.invalid/mcp", {
                mcp: { servers: { remote: { url: "https://mcp.invalid/mcp", auth: "oauth" } } },
              }),
            })
          : fetchFixture,
      },
    );
    transports.push(transport);
    return {
      transport,
      description: "unreachable fixture",
      transportType: "streamable-http",
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
      supportsParallelToolCalls: true,
    };
  });
});

it.each(["embedded", "native"])(
  "remembers %s OAuth-required startup until the credential owner changes",
  async (mode) => {
    await withOpenClawTestState({ prefix: "mcp-startup-oauth-" }, async () => {
      oauthRequired = true;
      reachable = true;
      const catalogFor = async (runtime: SessionMcpRuntime) => {
        if (mode === "embedded") {
          return runtime.getCatalog();
        }
        const view = await acquireNativeMcpServer(runtime, "remote", {
          capabilityContext: {},
          capabilities: {},
          roots: { roots: [] },
          assertCurrent() {},
        }).catch(() => undefined);
        if (!view) {
          return runtime.getCatalog();
        }
        try {
          return await view.runtime.getCatalog();
        } finally {
          await view.release();
        }
      };
      const first = makeRuntime();
      const denied = await catalogFor(first);
      expect(toolNames(denied)).toEqual([]);
      expect(denied.diagnostics?.[0]?.message).toContain("Sign in from Settings");
      await vi.advanceTimersByTimeAsync(86_400_000);
      for (let index = 0; index < 8; index++) {
        expect(toolNames(await catalogFor(makeRuntime()))).toEqual([]);
      }
      const otherWorkspace = createSessionMcpRuntime({
        sessionId: "other-workspace",
        workspaceDir: "/other-workspace",
        agentDir: "/other-agent",
        cfg: { mcp: { servers: { remote: remoteServer } } },
      });
      runtimes.push(otherWorkspace);
      expect(toolNames(await catalogFor(otherWorkspace))).toEqual([]);
      expect(initializes).toBe(1);
      expect(transports).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);

      await saveMcpOAuthAccessTokenForTest(
        operatorMcpOAuthIdentity("other", remoteServer.url),
        "synthetic-other",
      );
      expect(toolNames(await first.getCatalog())).toEqual([]);
      expect(initializes).toBe(1);
      await saveMcpOAuthAccessTokenForTest(
        operatorMcpOAuthIdentity("remote", remoteServer.url),
        "synthetic-remote",
      );
      expect(toolNames(await catalogFor(first))).toEqual(["probe"]);
      expect(toolNames(await catalogFor(makeRuntime()))).toEqual(["probe"]);
      expect(toolNames(await catalogFor(otherWorkspace))).toEqual(["probe"]);
      expect(initializes).toBe(4);
    });
  },
);

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await disposeAllSessionMcpRuntimes();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const remoteServer = { url: "https://mcp.invalid/mcp" };
function makeRuntime(
  url = remoteServer.url,
  requesterScope?: SessionMcpRequesterScope,
  servers: NonNullable<OpenClawConfig["mcp"]>["servers"] = { remote: { url } },
) {
  const runtime = createSessionMcpRuntime({
    sessionId: `run-${runtimes.length}`,
    workspaceDir: "/workspace",
    requesterScope,
    cfg: { mcp: { servers } },
  });
  runtimes.push(runtime);
  return runtime;
}

const toolNames = (catalog: Awaited<ReturnType<SessionMcpRuntime["getCatalog"]>>) =>
  catalog.tools.map((tool) => tool.toolName);

async function discover(runtime: SessionMcpRuntime) {
  let settled = false;
  const started = Date.now();
  const pending = runtime.getCatalog().finally(() => {
    settled = true;
  });
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
  if (!settled) {
    await vi.advanceTimersToNextTimerAsync();
  }
  return { catalog: await pending, waitedMs: Date.now() - started };
}

it.each(["connection", "listing"] as const)(
  "keeps %s failures stable while recovering without stalling healthy siblings",
  async (failure) => {
    reachable = failure === "listing";
    invalidListing = failure === "listing";
    const runtime = makeRuntime(undefined, undefined, {
      remote: remoteServer,
      healthy: { url: "https://healthy.invalid/mcp" },
    });
    const failed = await discover(runtime);
    expect(failed.waitedMs).toBe(failure === "connection" ? 30_000 : 0);
    expect(toolNames(failed.catalog)).toEqual(["healthy_tool"]);
    const diagnostics = structuredClone(failed.catalog.diagnostics);
    expect(diagnostics).toEqual([expect.objectContaining({ serverName: "remote" })]);
    vi.setSystemTime(Date.now() + (failure === "connection" ? 600_000 : -600_000));
    expect((await runtime.getCatalog()).diagnostics).toEqual(diagnostics);

    reachable = true;
    invalidListing = false;
    const listing = Promise.withResolvers<void>();
    listToolsGate = listing.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect((await discover(runtime)).waitedMs).toBe(0);
    expect(initializes).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const turn = await discover(runtime);
    expect(turn).toMatchObject({ waitedMs: 0, catalog: { diagnostics } });
    listing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const recovered = await runtime.getCatalog();
    expect(toolNames(recovered)).toEqual(["healthy_tool", "probe"]);
    expect(recovered.diagnostics ?? []).toEqual([]);
    expect(toolNames(turn.catalog)).toEqual(["healthy_tool"]);
    expect(initializes).toBe(3);
  },
);

it("refreshes a connected session while a sibling with the same startup key is unavailable", async () => {
  reachable = true;
  const healthy = makeRuntime();
  const before = await healthy.getCatalog();
  expect(toolNames(before)).toEqual(["probe"]);
  const transport = transports[0]!;

  reachable = false;
  const failed = await discover(makeRuntime());
  expect(failed.waitedMs).toBe(30_000);
  expect(failed.catalog.diagnostics?.[0]?.message).toContain("server unavailable");

  remoteToolName = "replacement";
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await vi.advanceTimersByTimeAsync(0);
  const refreshed = await healthy.getCatalog();
  expect(toolNames(refreshed)).toEqual(["replacement"]);
  expect(refreshed.diagnostics).toBeUndefined();
  expect(initializes).toBe(2);
  expect(toolNames(before)).toEqual(["probe"]);
});

it("clears inherited failure cooldowns when the live runtime is explicitly reloaded", async () => {
  await bindSessionMcpRuntimeTestScheduler();
  const params = {
    workspaceDir: "/workspace",
    agentDir: "/agent",
    cfg: { mcp: { servers: { remote: remoteServer } } },
  };
  const first = await acquireSessionMcpRuntime({ ...params, sessionId: "first" });
  const second = await acquireSessionMcpRuntime({ ...params, sessionId: "second" });
  try {
    await discover(first.runtime);
    expect((await discover(second.runtime)).waitedMs).toBe(0);
    reachable = true;
    await reloadSessionMcpRuntimes({ cfg: params.cfg });
    const reloaded = await second.runtime.getCatalog();
    expect(toolNames(reloaded)).toEqual(["probe"]);
  } finally {
    first.releaseLease();
    second.releaseLease();
  }
});

it("doubles background retry intervals to ten minutes and resets after recovery", async () => {
  const runtime = makeRuntime();
  expect((await discover(runtime)).waitedMs).toBe(30_000);
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
  await vi.advanceTimersByTimeAsync(4_999);
  expect((await discover(runtime)).waitedMs).toBe(0);
  expect(initializes).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  for (const delay of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    expect((await discover(runtime)).waitedMs).toBe(0);
    if (delay === 60_000) {
      expect(initializes).toBe(2);
      // A new session must not join an in-flight retry after its cooldown expires.
      await vi.advanceTimersByTimeAsync(25_000);
      expect((await discover(makeRuntime())).waitedMs).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
    } else {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const failed = await discover(runtime);
    if (delay === 60_000) {
      expect(warn).toHaveBeenCalledTimes(2);
    }
    expect(failed.catalog.diagnostics?.[0]?.message).toContain(
      `server unavailable; retry after ${new Date(Date.now() + delay).toISOString()}. Check server reachability`,
    );
    const attempts = initializes;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect((await discover(makeRuntime())).waitedMs).toBe(0);
    expect(initializes).toBe(attempts);
    await vi.advanceTimersByTimeAsync(1);
  }
  reachable = true;
  expect((await discover(runtime)).waitedMs).toBe(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(toolNames(await runtime.getCatalog())).toEqual(["probe"]);
  reachable = false;
  const failedAgain = await discover(makeRuntime());
  expect(failedAgain.waitedMs).toBe(30_000);
  expect(failedAgain.catalog.diagnostics?.[0]?.message).toContain(
    new Date(Date.now() + 5_000).toISOString(),
  );
});

it("preserves known failure when a session retires during a background retry", async () => {
  const runtime = makeRuntime();
  await discover(runtime);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await discover(runtime)).waitedMs).toBe(0);
  await runtime.dispose();
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
});

it("shares a single failed startup across concurrent sessions", async () => {
  const pending = Promise.all(Array.from({ length: 4 }, () => makeRuntime().getCatalog()));
  await vi.advanceTimersByTimeAsync(30_000);
  const catalogs = await pending;
  expect(
    catalogs.every((catalog) => catalog.diagnostics?.[0]?.message.includes("unavailable")),
  ).toBe(true);
  expect(initializes).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
});

it.each([
  {
    change: "configuration",
    url: "https://changed.invalid/mcp",
    requesterScope: undefined,
    reset: () => reloadSessionMcpRuntimes({ cfg: {} }),
  },
  {
    change: "requester",
    url: undefined,
    requesterScope: { requesterSenderId: "alice" },
    reset: disposeAllSessionMcpRuntimes,
  },
])(
  "isolates $change failures and resets them on explicit reload",
  async ({ url, requesterScope, reset }) => {
    await discover(makeRuntime());
    expect((await discover(makeRuntime())).waitedMs).toBe(0);
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(30_000);
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(0);
    await reset();
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(30_000);
    expect(initializes).toBe(3);
  },
);
