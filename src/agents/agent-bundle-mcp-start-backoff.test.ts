import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  reloadSessionMcpRuntimes,
} from "./agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "./agent-bundle-mcp-manager.test-support.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRequesterScope, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { OpenClawStreamableHTTPClientTransport } from "./mcp-http-transport.js";

const { resolveTransport, warn } = vi.hoisted(() => ({
  resolveTransport: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./mcp-transport.js", () => ({ resolveMcpTransport: resolveTransport }));
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  transports.length = 0;
  initializes = 0;
  remoteToolName = "probe";
  reachable = false;
  invalidListing = false;
  listToolsGate = undefined;
  warn.mockClear();
  resolveTransport.mockImplementation((serverName: string) => {
    const transport = new OpenClawStreamableHTTPClientTransport(
      new URL("https://mcp.invalid/mcp"),
      {
        fetch: async (_input, init) => {
          if (init?.method !== "POST") {
            return new Response(null, { status: 405 });
          }
          if (typeof init.body !== "string") {
            throw new Error("Expected a serialized JSON-RPC request body");
          }
          const message = JSON.parse(init.body) as { id?: number; method: string };
          if (message.method === "initialize") {
            initializes += 1;
            if (!reachable && serverName === "remote") {
              return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener(
                  "abort",
                  () =>
                    reject(new Error("Fixture request aborted", { cause: init.signal?.reason })),
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
          return new Response(
            JSON.stringify({
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
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    );
    transports.push(transport);
    return {
      transport,
      description: "unreachable fixture",
      transportType: "streamable-http",
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 60_000,
    };
  });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await disposeAllSessionMcpRuntimes();
  vi.useRealTimers();
});

function makeRuntime(url = "https://mcp.invalid/mcp", requesterScope?: SessionMcpRequesterScope) {
  const runtime = createSessionMcpRuntime({
    sessionId: `run-${runtimes.length}`,
    workspaceDir: "/workspace",
    requesterScope,
    cfg: { mcp: { servers: { remote: { url } } } },
  });
  runtimes.push(runtime);
  return runtime;
}

async function discover(runtime: SessionMcpRuntime) {
  let settled = false;
  const started = Date.now();
  const pending = runtime.getCatalog().finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  if (!settled) {
    await vi.advanceTimersToNextTimerAsync();
  }
  return { catalog: await pending, waitedMs: Date.now() - started };
}

it("bounds the first connection and never waits for known-failed retries", async () => {
  const runtime = makeRuntime();
  expect((await discover(runtime)).waitedMs).toBe(30_000);
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
  await vi.advanceTimersByTimeAsync(4_999);
  expect((await discover(runtime)).waitedMs).toBe(0);
  expect(initializes).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  expect((await discover(runtime)).waitedMs).toBe(0);
  expect(initializes).toBe(2);
  // New sessions must not join the pending retry, even after their cooldown expires.
  await vi.advanceTimersByTimeAsync(25_000);
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
  await vi.advanceTimersByTimeAsync(5_000);
  const failedRetry = await discover(runtime);
  expect(failedRetry.waitedMs).toBe(0);
  expect(failedRetry.catalog.diagnostics?.[0]?.message).toContain(
    new Date(Date.now() + 60_000).toISOString(),
  );
  expect(warn).toHaveBeenCalledTimes(2);
});

it("keeps one catalog diagnostic per failure episode and publishes recovery next turn", async () => {
  const runtime = makeRuntime();
  const failed = await discover(runtime);
  expect(failed.catalog.tools).toEqual([]);
  const diagnostics = structuredClone(failed.catalog.diagnostics);
  expect(diagnostics).toEqual([
    expect.objectContaining({
      serverName: "remote",
      message: expect.stringContaining("server unavailable"),
    }),
  ]);
  expect((await runtime.getCatalog()).diagnostics).toEqual(diagnostics);
  reachable = true;
  await vi.advanceTimersByTimeAsync(5_000);
  const listing = Promise.withResolvers<void>();
  listToolsGate = listing.promise;
  const turn = await discover(runtime);
  expect(turn.waitedMs).toBe(0);
  expect(turn.catalog.tools).toEqual([]);
  expect(turn.catalog.diagnostics).toEqual(diagnostics);
  expect(initializes).toBe(2);

  listing.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const recovered = await runtime.getCatalog();
  expect(recovered.tools.map((tool) => tool.toolName)).toEqual(["probe"]);
  expect(recovered.diagnostics ?? []).toEqual([]);
  expect(turn.catalog.tools).toEqual([]);
});

it("retries failed listings in the background without stalling healthy siblings", async () => {
  reachable = true;
  invalidListing = true;
  const runtime = createSessionMcpRuntime({
    sessionId: "listing-retry",
    workspaceDir: "/workspace",
    cfg: {
      mcp: {
        servers: {
          remote: { url: "https://mcp.invalid/mcp" },
          healthy: { url: "https://healthy.invalid/mcp" },
        },
      },
    },
  });
  runtimes.push(runtime);
  const failed = await runtime.getCatalog();
  expect(failed.tools.map((tool) => tool.toolName)).toEqual(["healthy_tool"]);
  expect(failed.diagnostics?.[0]?.serverName).toBe("remote");

  invalidListing = false;
  const listing = Promise.withResolvers<void>();
  listToolsGate = listing.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  const turn = await discover(runtime);
  expect(turn.waitedMs).toBe(0);
  expect(turn.catalog.tools.map((tool) => tool.toolName)).toEqual(["healthy_tool"]);
  listing.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const recovered = await runtime.getCatalog();
  expect(recovered.tools.map((tool) => tool.toolName)).toEqual(["healthy_tool", "probe"]);
  expect(recovered.diagnostics).toBeUndefined();
  expect(initializes).toBe(3);
});

it("refreshes a connected session while a sibling with the same startup key is unavailable", async () => {
  reachable = true;
  const healthy = makeRuntime();
  const before = await healthy.getCatalog();
  expect(before.tools.map((tool) => tool.toolName)).toEqual(["probe"]);
  const transport = transports[0]!;

  reachable = false;
  const failed = await discover(makeRuntime());
  expect(failed.waitedMs).toBe(30_000);
  expect(failed.catalog.diagnostics?.[0]?.message).toContain("server unavailable");

  remoteToolName = "replacement";
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await vi.advanceTimersByTimeAsync(0);
  const refreshed = await healthy.getCatalog();
  expect(refreshed.tools.map((tool) => tool.toolName)).toEqual(["replacement"]);
  expect(refreshed.diagnostics).toBeUndefined();
  expect(initializes).toBe(2);
  expect(before.tools.map((tool) => tool.toolName)).toEqual(["probe"]);
});

it("clears inherited failure cooldowns when the live runtime is explicitly reloaded", async () => {
  await bindSessionMcpRuntimeTestScheduler();
  const params = {
    workspaceDir: "/workspace",
    agentDir: "/agent",
    cfg: { mcp: { servers: { remote: { url: "https://mcp.invalid/mcp" } } } },
  };
  const first = await acquireSessionMcpRuntime({ ...params, sessionId: "first" });
  const second = await acquireSessionMcpRuntime({ ...params, sessionId: "second" });
  try {
    await discover(first.runtime);
    expect((await discover(second.runtime)).waitedMs).toBe(0);
    reachable = true;
    await reloadSessionMcpRuntimes({ cfg: params.cfg });
    const reloaded = await second.runtime.getCatalog();
    expect(reloaded.tools.map((tool) => tool.toolName)).toEqual(["probe"]);
  } finally {
    first.releaseLease();
    second.releaseLease();
  }
});

it("doubles background retry intervals to ten minutes and resets after recovery", async () => {
  const runtime = makeRuntime();
  await discover(runtime);
  await vi.advanceTimersByTimeAsync(5_000);
  for (const delay of [60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    expect((await discover(runtime)).waitedMs).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const failed = await discover(runtime);
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
  expect((await runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual(["probe"]);
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
