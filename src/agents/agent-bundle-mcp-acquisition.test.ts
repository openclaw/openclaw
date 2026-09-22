import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { materializeRequesterScopedMcpToolsForHarnessRunCore } from "./agent-bundle-mcp-harness.js";
import {
  acquireRequesterScopedMcpRuntime,
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
  releaseSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createMcpProbeFixture, probeMcpServer } from "./agent-bundle-mcp-probe.test-support.js";
import {
  SESSION_MCP_MAX_LIVE_RUNTIMES,
  SESSION_MCP_RUNTIME_MANAGER_KEY,
} from "./agent-bundle-mcp-runtime-shared.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";

const readAuthorization = vi.hoisted(() =>
  vi.fn(async (identities: readonly McpOAuthIdentity[]) =>
    identities.map(() => ({ state: "unauthenticated" })),
  ),
);
vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: readAuthorization,
  startMcpOAuthAuthorization: async () => ({ status: "authorized" }),
}));

const tempDirs: string[] = [];
const releases: Array<() => void> = [];
beforeEach(async () => {
  await disposeAllSessionMcpRuntimes();
  // The process singleton's lazy factory must not retain another test file's OAuth mock.
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
});
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await disposeAllSessionMcpRuntimes();
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  cleanupTempDirs(tempDirs);
  readAuthorization
    .mockReset()
    .mockImplementation(async (identities: readonly McpOAuthIdentity[]) =>
      identities.map(() => ({ state: "unauthenticated" })),
    );
});

it("retires excluded discovery servers while retaining prepared session tools", async () => {
  const { params, config } = await createMcpProbeFixture(tempDirs);
  const acquired = await acquireSessionMcpRuntime({ ...params, cfg: config() });
  const healthy = await probeMcpServer(acquired.runtime, "healthy");
  const excluded = await probeMcpServer(acquired.runtime, "changed");

  await releaseSessionMcpRuntime(acquired, new Set(["healthy"]));

  expect(() => process.kill(excluded.pid, 0)).toThrow();
  expect(await probeMcpServer(acquired.runtime, "healthy")).toEqual(healthy);
  await disposeAllSessionMcpRuntimes();
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it("preserves an excluded server until its other active acquisition releases", async () => {
  const { params, config } = await createMcpProbeFixture(tempDirs);
  const input = { ...params, cfg: config() };
  const discovery = await acquireSessionMcpRuntime(input);
  const active = await acquireSessionMcpRuntime(input);
  const healthy = await probeMcpServer(active.runtime, "healthy");
  const excluded = await probeMcpServer(active.runtime, "changed");

  await releaseSessionMcpRuntime(discovery, new Set(["healthy"]));
  expect(await probeMcpServer(active.runtime, "changed")).toEqual(excluded);

  await releaseSessionMcpRuntime(active, new Set(["healthy"]));
  expect(() => process.kill(excluded.pid, 0)).toThrow();
  expect(await probeMcpServer(active.runtime, "healthy")).toEqual(healthy);
});

it("does not let stale discovery prune servers transferred to a replacement", async () => {
  const { params, config } = await createMcpProbeFixture(tempDirs);
  const original = await acquireSessionMcpRuntime({ ...params, cfg: config() });
  const healthy = await probeMcpServer(original.runtime, "healthy");
  const previous = await probeMcpServer(original.runtime, "changed");
  const replacement = await acquireSessionMcpRuntime({ ...params, cfg: config("replacement") });
  const changed = await probeMcpServer(replacement.runtime, "changed");
  expect(changed.label).toBe("replacement");
  expect(changed.pid).not.toBe(previous.pid);
  await releaseSessionMcpRuntime(replacement);

  await releaseSessionMcpRuntime(original, new Set());

  expect(await probeMcpServer(replacement.runtime, "healthy")).toEqual(healthy);
  expect(await probeMcpServer(replacement.runtime, "changed")).toEqual(changed);
});

it("releases capacity when every configured server is excluded before connection", async () => {
  const { params, config } = await createMcpProbeFixture(tempDirs);
  const cfg = config();
  await expect(
    (async () => {
      for (let index = 0; index <= SESSION_MCP_MAX_LIVE_RUNTIMES; index += 1) {
        const sessionKey = `agent:main:excluded-${index}`;
        const acquired = await acquireSessionMcpRuntime({
          ...params,
          sessionId: `excluded-${index}`,
          sessionKey,
          cfg,
        });
        await releaseSessionMcpRuntime(acquired, new Set());
        expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
        expect(
          getSessionMcpRuntimeManagerForTesting().resolveSessionId(sessionKey),
        ).toBeUndefined();
      }
    })(),
  ).resolves.toBeUndefined();
});

it.each(["exported acquisition", "harness materialization"])(
  "admits requester leases through %s",
  async (surface) => {
    const { params, config } = await createMcpProbeFixture(tempDirs);
    const cfg = config();
    cfg.gateway = { publicOrigin: "https://gateway.example.test" };
    cfg.mcp!.servers!.calendar = {
      transport: "streamable-http",
      url: "https://mcp.example.test",
      auth: "oauth",
      oauth: { identity: "per-requester" },
    };
    const input = { ...params, cfg, requesterSenderId: "alice" };
    const acquired = await acquireSessionMcpRuntime(input);
    const original = await materializeBundleMcpToolsForRun(acquired);
    const healthy = await probeMcpServer(acquired.runtime, "healthy");
    const manager = getSessionMcpRuntimeManagerForTesting();
    const started = createDeferred();
    const released = createDeferred();
    releases.push(() => released.resolve());
    readAuthorization.mockImplementationOnce(async (identities) => {
      started.resolve();
      await released.promise;
      return identities.map(() => ({ state: "unauthenticated" }));
    });
    const pending =
      surface === "exported acquisition"
        ? acquireRequesterScopedMcpRuntime(input)
        : materializeRequesterScopedMcpToolsForHarnessRunCore(input);
    void pending.catch(() => undefined);
    await started.promise;
    manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
    const retiring = original.dispose();
    await expect.poll(() => manager.totalActiveLeasesForSession(params.sessionId)).toBe(0);
    released.resolve();
    const nextAcquired = expectDefined(await pending, "requester acquisition");
    await retiring;
    expect(manager.totalActiveLeasesForSession(params.sessionId)).toBeGreaterThan(0);
    const next =
      "runtime" in nextAcquired
        ? await materializeBundleMcpToolsForRun(nextAcquired)
        : nextAcquired;
    try {
      expect(next.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
      expect(await probeMcpServer(acquired.runtime, "healthy")).toEqual(healthy);
    } finally {
      await next.dispose();
    }
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(() => process.kill(healthy.pid, 0)).toThrow();
  },
);

it("releases static admission when requester resolution fails during required retirement", async () => {
  const { params, config } = await createMcpProbeFixture(tempDirs);
  const cfg = config();
  cfg.mcp!.servers!.calendar = {
    transport: "streamable-http",
    url: "https://mcp.example.test",
    auth: "oauth",
    oauth: { identity: "per-requester" },
  };
  const input = { ...params, cfg, requesterSenderId: "alice" };
  const original = await acquireSessionMcpRuntime(input);
  const healthy = await probeMcpServer(original.runtime, "healthy");
  original.releaseLease();
  const manager = getSessionMcpRuntimeManagerForTesting();
  readAuthorization.mockImplementationOnce(async () => {
    manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
    throw new Error("requester authorization unavailable");
  });
  await expect(acquireSessionMcpRuntime(input)).rejects.toThrow(
    "requester authorization unavailable",
  );
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it.each(["empty", "catalog failure"])(
  "releases admission on %s materialization",
  async (result) => {
    const { params } = await createMcpProbeFixture(tempDirs);
    const acquired = await acquireSessionMcpRuntime({
      ...params,
      cfg: { plugins: { enabled: false } },
    });
    const manager = getSessionMcpRuntimeManagerForTesting();
    expect(acquired.runtime.activeLeases).toBe(1);
    manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
    if (result === "catalog failure") {
      vi.spyOn(acquired.runtime, "getCatalog").mockRejectedValueOnce(
        new Error("catalog unavailable"),
      );
      await expect(materializeBundleMcpToolsForRun(acquired)).rejects.toThrow(
        "catalog unavailable",
      );
    } else {
      const materialized = await materializeBundleMcpToolsForRun(acquired);
      expect(materialized.tools).toEqual([]);
      expect(acquired.runtime.activeLeases).toBe(1);
      await materialized.dispose();
    }
    expect(acquired.runtime.activeLeases).toBe(0);
    expect(manager.listRuntimeKeys()).toEqual([]);
  },
);
