import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import * as harness from "./agent-bundle-mcp-harness.js";
import {
  acquireRequesterScopedMcpRuntime as acquireRequester,
  acquireSessionMcpRuntime as acquire,
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "./agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime as release } from "./agent-bundle-mcp-manager-cleanup.js";
import { getSessionMcpRuntimeTestManager as getManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun as materialize } from "./agent-bundle-mcp-materialize.js";
import {
  createMcpProbeFixture,
  probeMcpServer as probe,
} from "./agent-bundle-mcp-probe.test-support.js";
import {
  SESSION_MCP_MAX_LIVE_RUNTIMES,
  SESSION_MCP_RUNTIME_MANAGER_KEY,
} from "./agent-bundle-mcp-runtime-shared.js";
const readAuthorization = vi.hoisted(() => vi.fn(async () => [{ state: "unauthenticated" }]));
vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: readAuthorization,
  startMcpOAuthAuthorization: async () => ({ status: "authorized" }),
}));

const tempDirs: string[] = [];
let oauthRelease: ReturnType<typeof createDeferred<void>>;
let fixture: Awaited<ReturnType<typeof createMcpProbeFixture>>;

function requesterFixture() {
  const cfg = fixture.config();
  cfg.mcp!.servers!.calendar = {
    transport: "streamable-http",
    url: "https://mcp.example.test",
    auth: "oauth",
    oauth: { identity: "per-requester" },
  };
  return { ...fixture.params, cfg, requesterSenderId: "alice" };
}
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
let manager: ReturnType<typeof getManager>;
beforeEach(async () => {
  await disposeAllSessionMcpRuntimes();
  oauthRelease = createDeferred();
  // The process singleton's lazy factory must not retain another test file's OAuth mock.
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
  manager = getManager();
  fixture = await createMcpProbeFixture(tempDirs);
});
afterEach(async () => {
  oauthRelease.resolve();
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  cleanupTempDirs(tempDirs);
  readAuthorization.mockReset().mockResolvedValue([{ state: "unauthenticated" }]);
});

it.each([false, true])("retires excluded servers after final release (%s)", async (shared) => {
  const input = { ...fixture.params, cfg: fixture.config() };
  const discovery = await acquire(input);
  const active = shared ? await acquire(input) : discovery;
  const healthy = await probe(active.runtime, "healthy");
  const excluded = await probe(active.runtime, "changed");

  await release(discovery, new Set(["healthy"]));
  if (shared) {
    expect(await probe(active.runtime, "changed")).toEqual(excluded);
    await release(active, new Set(["healthy"]));
  }
  expect(() => process.kill(excluded.pid, 0)).toThrow();
  expect(await probe(active.runtime, "healthy")).toEqual(healthy);
  await disposeAllSessionMcpRuntimes();
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it("does not let stale discovery prune servers transferred to a replacement", async () => {
  const original = await acquire({ ...fixture.params, cfg: fixture.config() });
  const healthy = await probe(original.runtime, "healthy");
  const previous = await probe(original.runtime, "changed");
  const replacement = await acquire({ ...fixture.params, cfg: fixture.config("replacement") });
  const changed = await probe(replacement.runtime, "changed");
  expect(changed.label).toBe("replacement");
  expect(changed.pid).not.toBe(previous.pid);
  await release(replacement);

  await release(original, new Set());

  expect(await probe(replacement.runtime, "healthy")).toEqual(healthy);
  expect(await probe(replacement.runtime, "changed")).toEqual(changed);
});

it("releases capacity when every configured server is excluded before connection", async () => {
  const input = { ...fixture.params, cfg: fixture.config() };
  for (let index = 0; index <= SESSION_MCP_MAX_LIVE_RUNTIMES; index += 1) {
    const sessionKey = `agent:main:excluded-${index}`;
    const acquired = await acquire({ ...input, sessionId: `excluded-${index}`, sessionKey });
    await release(acquired, new Set());
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
  }
});

it.each(["exported", "harness"])("admits requester leases through %s", async (surface) => {
  const input = requesterFixture();
  input.cfg.gateway = { publicOrigin: "https://gateway.example.test" };
  const acquired = await acquire(input);
  const original = await materialize(acquired);
  const healthy = await probe(acquired.runtime, "healthy");
  const started = createDeferred();
  readAuthorization.mockImplementationOnce(async () => {
    started.resolve();
    await oauthRelease.promise;
    return [{ state: "unauthenticated" }];
  });
  const pending =
    surface === "exported"
      ? acquireRequester(input)
      : harness.materializeRequesterScopedMcpToolsForHarnessRunCore(input);
  void pending.catch(() => undefined);
  await started.promise;
  manager.deferRetirement(input.sessionId, { retainAcrossReuse: true });
  const retiring = original.dispose();
  await expect.poll(() => manager.totalActiveLeasesForSession(input.sessionId)).toBe(0);
  oauthRelease.resolve();
  const nextAcquired = expectDefined(await pending, "requester acquisition");
  await retiring;
  expect(manager.totalActiveLeasesForSession(input.sessionId)).toBeGreaterThan(0);
  const next = "runtime" in nextAcquired ? await materialize(nextAcquired) : nextAcquired;
  expect(next.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
  expect(await probe(acquired.runtime, "healthy")).toEqual(healthy);
  await next.dispose();
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it("releases static admission when requester resolution fails during required retirement", async () => {
  const input = requesterFixture();
  const original = await acquire(input);
  const healthy = await probe(original.runtime, "healthy");
  original.releaseLease();
  readAuthorization.mockImplementationOnce(async () => {
    manager.deferRetirement(input.sessionId, { retainAcrossReuse: true });
    throw new Error("requester authorization unavailable");
  });
  await expect(acquire(input)).rejects.toThrow("requester authorization unavailable");
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it.each(["empty", "catalog failure"])("releases admission on %s catalog", async (result) => {
  const acquired = await acquire({ ...fixture.params, cfg: { plugins: { enabled: false } } });
  expect(acquired.runtime.activeLeases).toBe(1);
  manager.deferRetirement(fixture.params.sessionId, { retainAcrossReuse: true });
  if (result === "catalog failure") {
    const failure = new Error("catalog unavailable");
    vi.spyOn(acquired.runtime, "getCatalog").mockRejectedValueOnce(failure);
    await expect(materialize(acquired)).rejects.toThrow(failure.message);
  } else {
    const materialized = await materialize(acquired);
    expect(materialized.tools).toEqual([]);
    expect(acquired.runtime.activeLeases).toBe(1);
    await materialized.dispose();
  }
  expect(acquired.runtime.activeLeases).toBe(0);
  expect(manager.listRuntimeKeys()).toEqual([]);
});
