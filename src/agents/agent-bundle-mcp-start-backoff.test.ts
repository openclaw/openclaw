import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
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
let initializes = 0;
let reachable = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  initializes = 0;
  reachable = false;
  warn.mockClear();
  resolveTransport.mockImplementation(() => ({
    transport: new OpenClawStreamableHTTPClientTransport(new URL("https://mcp.invalid/mcp"), {
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
          if (!reachable) {
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
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fixture", version: "1" },
                  }
                : { tools: [{ name: "probe", inputSchema: { type: "object" } }] },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    }),
    description: "unreachable fixture",
    transportType: "streamable-http",
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 60_000,
  }));
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

it("remembers a startup timeout across runs and reports unavailable without repeated waits or logs", async () => {
  const waits: number[] = [];
  for (let run = 0; run < 8; run += 1) {
    const runtime = makeRuntime();
    const { catalog, waitedMs } = await discover(runtime);
    waits.push(waitedMs);
    expect(catalog.tools).toEqual([]);
    expect(catalog.diagnostics?.[0]?.message).toContain("timed out");
    expect(catalog.diagnostics?.[0]?.message).toContain(
      `server unavailable; retry after ${run === 0 ? "2026-01-01T00:00:35.000Z" : "2026-01-01T00:01:00.000Z"}. Check server reachability`,
    );
    await runtime.dispose();
  }
  console.log(
    JSON.stringify({
      initializes,
      waits,
      warnings: warn.mock.calls.length,
      rss: process.memoryUsage().rss,
    }),
  );
  expect(waits).toEqual([30_000, 0, 0, 0, 0, 0, 0, 0]);
  expect(initializes).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("allows only the first failing runtime one early catalog retry before backing off", async () => {
  const runtime = makeRuntime();
  await discover(runtime);
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
  await vi.advanceTimersByTimeAsync(4_999);
  await discover(runtime);
  expect(initializes).toBe(1);

  await vi.advanceTimersByTimeAsync(1);
  await runtime.getCatalog();
  await vi.advanceTimersByTimeAsync(0);
  expect(initializes).toBe(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
    new Date(Date.now() + 60_000).toISOString(),
  );

  await vi.advanceTimersByTimeAsync(5_000);
  await discover(runtime);
  expect((await discover(makeRuntime())).waitedMs).toBe(0);
  expect(initializes).toBe(2);
  expect(warn).toHaveBeenCalledTimes(2);
});

it("doubles the retry interval to ten minutes and resets it after recovery", async () => {
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
    const runtime = makeRuntime();
    const failed = await discover(runtime);
    expect(failed.waitedMs).toBe(30_000);
    expect(failed.catalog.diagnostics?.[0]?.message).toContain(
      new Date(Date.now() + (delay === 30_000 ? 5_000 : delay)).toISOString(),
    );
    await runtime.dispose();
    const attempts = initializes;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect((await discover(makeRuntime())).waitedMs).toBe(0);
    expect(initializes).toBe(attempts);
    expect(warn).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
  }
  reachable = true;
  const recovered = await discover(makeRuntime());
  expect(recovered.catalog.tools.map((tool) => tool.toolName)).toEqual(["probe"]);
  expect(recovered.catalog.diagnostics).toBeUndefined();
  reachable = false;
  const failedAgain = await discover(makeRuntime());
  expect(failedAgain.waitedMs).toBe(30_000);
  expect(failedAgain.catalog.diagnostics?.[0]?.message).toContain(
    new Date(Date.now() + 5_000).toISOString(),
  );
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
  { change: "configuration", url: "https://changed.invalid/mcp", requesterScope: undefined },
  { change: "requester", url: undefined, requesterScope: { requesterSenderId: "alice" } },
])(
  "isolates $change failures and resets them on explicit reload",
  async ({ url, requesterScope }) => {
    await discover(makeRuntime());
    expect((await discover(makeRuntime())).waitedMs).toBe(0);
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(30_000);
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(0);
    await disposeAllSessionMcpRuntimes();
    expect((await discover(makeRuntime(url, requesterScope))).waitedMs).toBe(30_000);
    expect(initializes).toBe(3);
  },
);

it("invalidates a startup failure that completes after config publication", async () => {
  const cfg = { mcp: { servers: { remote: { url: "https://mcp.invalid/mcp" } } } };
  const manager = createSessionMcpRuntimeManager({
    createRuntime: createSessionMcpRuntime,
    enableIdleSweepTimer: false,
  });
  const { runtime, releaseLease } = await manager.acquire({
    sessionId: "reload-during-start",
    workspaceDir: "/workspace",
    cfg,
  });
  try {
    const pending = runtime.getCatalog();
    await vi.advanceTimersByTimeAsync(0);
    expect(initializes).toBe(1);
    await manager.reloadConfig({ cfg });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(initializes).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).diagnostics?.[0]?.message).toContain(
      new Date(Date.now() + 5_000).toISOString(),
    );
    await manager.reloadConfig({ cfg });
    reachable = true;
    expect((await discover(runtime)).catalog.tools).toHaveLength(1);
  } finally {
    releaseLease();
    await manager.disposeAll();
  }
});
