// ACPX tests cover service plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpxRuntime } from "./runtime.js";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));
const { prepareAcpxCodexAuthConfigMock } = vi.hoisted(() => ({
  prepareAcpxCodexAuthConfigMock: vi.fn(
    async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig,
  ),
}));
const { cleanupOpenClawOwnedAcpxProcessTreeMock } = vi.hoisted(() => ({
  cleanupOpenClawOwnedAcpxProcessTreeMock: vi.fn(
    async (
      _params: Parameters<
        (typeof import("./process-reaper.js"))["cleanupOpenClawOwnedAcpxProcessTree"]
      >[0],
    ): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { cleanupOpenClawOwnedAcpxPendingLeaseMock } = vi.hoisted(() => ({
  cleanupOpenClawOwnedAcpxPendingLeaseMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "missing-root",
    }),
  ),
}));
const { reapStaleOpenClawOwnedAcpxOrphansMock } = vi.hoisted(() => ({
  reapStaleOpenClawOwnedAcpxOrphansMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { acpxRuntimeConstructorMock, createAgentRegistryMock, createFileSessionStoreMock } =
  vi.hoisted(() => ({
    acpxRuntimeConstructorMock: vi.fn(function MockAcpxRuntime() {
      return {
        doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
        shutdown: vi.fn(async () => {}),
        isHealthy: vi.fn(() => true),
      };
    }),
    createAgentRegistryMock: vi.fn(() => ({})),
    createFileSessionStoreMock: vi.fn(() => ({})),
  }));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: acpxRuntimeConstructorMock,
  createAgentRegistry: createAgentRegistryMock,
  createFileSessionStore: createFileSessionStoreMock,
}));

vi.mock("./codex-auth-bridge.js", () => ({
  prepareAcpxCodexAuthConfig: prepareAcpxCodexAuthConfigMock,
}));

vi.mock("./process-reaper.js", () => ({
  cleanupOpenClawOwnedAcpxPendingLease: cleanupOpenClawOwnedAcpxPendingLeaseMock,
  cleanupOpenClawOwnedAcpxProcessTree: cleanupOpenClawOwnedAcpxProcessTreeMock,
  reapStaleOpenClawOwnedAcpxOrphans: reapStaleOpenClawOwnedAcpxOrphansMock,
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import type { OpenClawPluginServiceContext } from "../runtime-api.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  openAcpxProcessLeaseStateStore,
  type AcpxProcessLease,
} from "./process-lease.js";
import { createAcpxRuntimeService as createRealAcpxRuntimeService } from "./service.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  type AcpxGatewayInstanceRecord,
} from "./state.js";

let testWorkspace: TempWorkspace;
const previousEnv = {
  OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE,
  OPENCLAW_SKIP_ACPX_RUNTIME: process.env.OPENCLAW_SKIP_ACPX_RUNTIME,
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE,
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(async () => {
  testWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-acpx-service-",
  });
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  runtimeRegistry.clear();
  prepareAcpxCodexAuthConfigMock.mockClear();
  cleanupOpenClawOwnedAcpxProcessTreeMock.mockClear();
  cleanupOpenClawOwnedAcpxPendingLeaseMock.mockClear();
  reapStaleOpenClawOwnedAcpxOrphansMock.mockClear();
  acpxRuntimeConstructorMock.mockClear();
  createAgentRegistryMock.mockClear();
  createFileSessionStoreMock.mockClear();
  restoreEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE");
  await testWorkspace.cleanup();
});

function createServiceContext(workspaceDir: string): OpenClawPluginServiceContext {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".openclaw-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createOpenKeyedStore(ctx: OpenClawPluginServiceContext) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: ctx.stateDir };
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("acpx", {
      ...options,
      env: options.env ?? env,
    });
}

function createAcpxRuntimeService(
  ctx: OpenClawPluginServiceContext,
  params: Omit<Parameters<typeof createRealAcpxRuntimeService>[0], "backendLifecycle"> & {
    backendLifecycle?: Parameters<typeof createRealAcpxRuntimeService>[0]["backendLifecycle"];
  } = {},
) {
  const backendLifecycle = params.backendLifecycle ?? {
    publish(backend: { runtime: unknown; healthy?: () => boolean }) {
      runtimeRegistry.set("acpx", backend);
    },
    retract(runtime: unknown) {
      if (runtimeRegistry.get("acpx")?.runtime === runtime) {
        runtimeRegistry.delete("acpx");
      }
    },
  };
  return createRealAcpxRuntimeService({
    ...params,
    backendLifecycle,
    openKeyedStore: params.openKeyedStore ?? createOpenKeyedStore(ctx),
  });
}

function openGatewayInstanceStore(ctx: OpenClawPluginServiceContext) {
  return createOpenKeyedStore(ctx)<AcpxGatewayInstanceRecord>({
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  });
}

function openProcessLeaseStore(ctx: OpenClawPluginServiceContext) {
  return openAcpxProcessLeaseStateStore(createOpenKeyedStore(ctx));
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    findSession: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => {}),
    ensureSession: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    probeAvailability: vi.fn(async () => {}),
    isHealthy: vi.fn(() => true),
    doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    ...overrides,
  };
}

function createRuntimeWithoutProcesses() {
  return new AcpxRuntime({
    cwd: testWorkspace.dir,
    permissionMode: "deny-all",
    sessionStore: { load: async () => undefined, save: async () => {} },
    agentRegistry: { resolve: (agent) => agent, list: () => [] },
  });
}
async function seedActiveLease(
  ctx: OpenClawPluginServiceContext,
  overrides: Partial<AcpxProcessLease> = {},
) {
  const wrapperRoot = path.join(ctx.stateDir, "acpx");
  await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
    instanceId: "gw-test",
    createdAt: 1,
  });
  const lease: AcpxProcessLease = {
    leaseId: "active-sibling",
    gatewayInstanceId: "gw-test",
    sessionKey: "agent:main:acp:existing",
    wrapperRoot,
    wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
    rootPid: 101,
    commandHash: "existing-command",
    startedAt: 1,
    state: "open",
    ...overrides,
  };
  await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
  return lease;
}

function readFirstRuntimeFactoryInput(runtimeFactory: { mock: { calls: Array<Array<unknown>> } }) {
  const [call] = runtimeFactory.mock.calls;
  if (!call) {
    throw new Error("Expected runtimeFactory to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected runtimeFactory to be called with an options object");
  }
  return input as {
    pluginConfig: {
      timeoutSeconds?: number;
      probeAgent?: string;
    };
  };
}

describe("createAcpxRuntimeService", () => {
  it("publishes before probing and retracts the exact runtime through the injected lifecycle", async () => {
    delete process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE;
    const ctx = createServiceContext(testWorkspace.dir);
    const probeStarted = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    const events: string[] = [];
    const runtime = createMockRuntime({
      doctor: vi.fn(async () => {
        events.push("probe");
        probeStarted.resolve();
        await releaseProbe.promise;
        return { ok: true, message: "ok" };
      }),
    });
    const publish = vi.fn((backend: { runtime: unknown; healthy?: () => boolean }) => {
      events.push("publish");
      expect(backend.runtime).toBe(runtime);
      expect(backend.healthy?.()).toBe(true);
    });
    const retract = vi.fn((ownedRuntime: unknown) => {
      events.push("retract");
      expect(ownedRuntime).toBe(runtime);
    });
    const service = createAcpxRuntimeService(ctx, {
      backendLifecycle: { publish, retract },
      runtimeFactory: () => runtime as never,
    });

    let resolved = false;
    const starting = Promise.resolve(service.start(ctx)).then(() => {
      resolved = true;
    });
    await probeStarted.promise;
    // Let a premature startup return settle while the probe remains blocked.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resolved).toBe(false);

    expect(events).toEqual(["publish", "probe"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();

    await service.stop?.(ctx);
    expect(retract).toHaveBeenCalledWith(runtime);
    expect(events).toEqual(["publish", "probe", "retract"]);

    releaseProbe.resolve();
    await starting;
    expect(resolved).toBe(true);
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it.each([
    { startup: "0", skip: "0" },
    { startup: "1", skip: "1" },
  ])("skips startup probe and health (startup=$startup, skip=$skip)", async ({ startup, skip }) => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = startup;
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = skip;
    const ctx = createServiceContext(testWorkspace.dir);
    const stateDir = path.join(testWorkspace.dir, "custom-state");
    const runtime = createMockRuntime({ isHealthy: () => false });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { stateDir },
      runtimeFactory: () => runtime as never,
    });
    await service.start(ctx);
    await fs.access(stateDir);
    expect(runtime.doctor).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();
    await service.stop?.(ctx);
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
  });

  it("reaps stale ACPX process leases from the generated wrapper root at startup", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await seedActiveLease(ctx, {
      leaseId: "lease-1",
      sessionKey: "agent:codex:acp:test",
      rootPid: 101,
    });
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [101, 102],
      terminatedPids: [101, 102],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).toHaveBeenCalledWith({
      rootPid: 101,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gw-test",
      wrapperRoot,
      deps: { ...processCleanupDeps, assertCurrent: expect.any(Function) },
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");

    await service.stop?.(ctx);
  });

  it("keeps PID-bearing leases when startup process listing is unavailable", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const lease = await seedActiveLease(ctx, {
      leaseId: "lease-process-list-unavailable",
      sessionKey: "agent:codex:acp:test",
      rootPid: 101,
    });
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 101,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("recovers a pending ACPX lease from exact wrapper identity before retiring it", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await seedActiveLease(ctx, {
      leaseId: "lease-pending",
      sessionKey: "agent:codex:acp:test",
      rootPid: 0,
    });
    cleanupOpenClawOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [201, 202],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxPendingLeaseMock).toHaveBeenCalledWith({
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      deps: { ...processCleanupDeps, assertCurrent: expect.any(Function) },
    });
    expect(reapStaleOpenClawOwnedAcpxOrphansMock).toHaveBeenCalledWith({
      wrapperRoot,
      deps: { ...processCleanupDeps, assertCurrent: expect.any(Function) },
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");
    await expect(openProcessLeaseStore(ctx).lookup("lease-pending")).resolves.toBeUndefined();

    await service.stop?.(ctx);
  });

  it("keeps pending leases open when exact process evidence is ambiguous", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const lease = await seedActiveLease(ctx, {
      leaseId: "lease-ambiguous",
      sessionKey: "agent:codex:acp:test",
      rootPid: 0,
    });
    cleanupOpenClawOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [],
      skippedReason: "ambiguous-root",
    });
    reapStaleOpenClawOwnedAcpxOrphansMock.mockResolvedValueOnce({
      inspectedPids: [301],
      terminatedPids: [301],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps an absent pending probe lease open for unidentifiable descendants", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const lease = await seedActiveLease(ctx, {
      leaseId: "lease-probe-missing",
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      rootPid: 0,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps startup quiet when no process leases are open", async () => {
    const ctx = createServiceContext(testWorkspace.dir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("snapshots legacy session ownership when acquiring a runtime without probing", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    delete process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE;
    const ctx = createServiceContext(testWorkspace.dir);
    const service = createAcpxRuntimeService(ctx);
    const sessionsDir = path.join(testWorkspace.dir, "state", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    for (const id of ["global", "openclaw-owner-v1-existing", "agent:free:acp:test"]) {
      await fs.writeFile(path.join(sessionsDir, `${encodeURIComponent(id)}.json`), "{}");
    }

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    expect(backend.healthy).toBeUndefined();
    expect(acpxRuntimeConstructorMock).toHaveBeenCalledOnce();
    expect(acpxRuntimeConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        elicitationModes: ["form", "url"],
        openclawLegacyBareSessionKeys: new Set(["global", "openclaw-owner-v1-existing"]),
      }),
    );

    await service.stop?.(ctx);
  });

  it.each([
    [0.001, 1],
    [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
  ])(
    "passes timer-safe timeout %s to the real constructor boundary",
    async (timeoutSeconds, timeoutMs) => {
      const ctx = createServiceContext(testWorkspace.dir);
      const service = createAcpxRuntimeService(ctx, { pluginConfig: { timeoutSeconds } });
      try {
        process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
        await service.start(ctx);
        expect(acpxRuntimeConstructorMock).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs }),
        );
      } finally {
        await service.stop?.(ctx);
      }
    },
  );

  it("runs the embedded runtime probe at startup when explicitly enabled and reports health", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const ctx = createServiceContext(testWorkspace.dir);
    const doctor = vi.fn(async () => ({ ok: true, message: "ok" }));
    const runtime = createMockRuntime({
      doctor,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(doctor).toHaveBeenCalledOnce();
    expect(runtime.probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(true);

    await service.stop?.(ctx);
  });

  it("bounds startup diagnostics after an unhealthy probe", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const ctx = createServiceContext(testWorkspace.dir);
    const doctorStarted = createDeferred<void>();
    const releaseDoctor = createDeferred<{ ok: boolean; message: string }>();
    const runtime = createMockRuntime({
      isHealthy: () => false,
      doctor: vi.fn(() => {
        doctorStarted.resolve();
        return releaseDoctor.promise;
      }),
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
      runtimeFactory: () => runtime as never,
    });
    vi.useFakeTimers();
    let settled = false;
    const started = Promise.resolve(service.start(ctx)).then(() => {
      settled = true;
    });
    try {
      await doctorStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(runtime.doctor).toHaveBeenCalledOnce();
      expect(runtime.probeAvailability).not.toHaveBeenCalled();
      expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(false);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        "embedded acpx runtime setup failed: embedded acpx runtime backend startup probe timed out after 0.001s",
      );
    } finally {
      releaseDoctor.resolve({ ok: false, message: "unavailable" });
      await started;
      await service.stop?.(ctx);
      vi.useRealTimers();
    }
  });

  it.each([
    { allowedAgents: undefined, probeAgent: undefined, expected: undefined },
    { allowedAgents: ["  OpenCode  ", "codex"], probeAgent: undefined, expected: "opencode" },
    { allowedAgents: ["opencode"], probeAgent: "codex", expected: "codex" },
  ])(
    "resolves probe $expected and the default timeout",
    async ({ allowedAgents, probeAgent, expected }) => {
      const ctx = createServiceContext(testWorkspace.dir);
      ctx.config = { acp: { allowedAgents } };
      const runtime = createMockRuntime();
      const runtimeFactory = vi.fn(() => runtime as never);
      const service = createAcpxRuntimeService(ctx, {
        pluginConfig: { probeAgent },
        runtimeFactory,
      });
      try {
        await service.start(ctx);
        expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig).toMatchObject({
          timeoutSeconds: 120,
        });
        expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe(expected);
      } finally {
        await service.stop?.(ctx);
      }
    },
  );

  it("can skip the embedded runtime backend via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const ctx = createServiceContext(testWorkspace.dir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: runtimeFactory as never,
    });

    await service.start(ctx);

    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});

it("catalog-only acquisition and disposal preserve another active runtime lease", async () => {
  const ctx = createServiceContext(testWorkspace.dir);
  await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
    instanceId: "gw-test",
    createdAt: 1,
  });
  const primary = createRuntimeWithoutProcesses();
  const primaryShutdown = vi.spyOn(primary, "shutdown");
  const owner = createAcpxRuntimeService(ctx, {
    probeAtStartup: false,
    runtimeFactory: () => primary,
  });
  await owner.start(ctx);
  const lease = await seedActiveLease(ctx);
  const inspectionRuntime = createRuntimeWithoutProcesses();
  const inspectionShutdown = vi.spyOn(inspectionRuntime, "shutdown");
  const inspection = createAcpxRuntimeService(ctx, {
    startupPurpose: "inspection",
    probeAtStartup: false,
    runtimeFactory: () => inspectionRuntime,
    backendLifecycle: { publish: () => {}, retract: () => {} },
  });
  await inspection.start(ctx);
  await inspection.stop?.(ctx);
  expect(cleanupOpenClawOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
  expect(cleanupOpenClawOwnedAcpxPendingLeaseMock).not.toHaveBeenCalled();
  expect(reapStaleOpenClawOwnedAcpxOrphansMock).not.toHaveBeenCalled();
  expect(await openProcessLeaseStore(ctx).lookup(lease.leaseId)).toEqual(lease);
  expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(primary);
  expect(inspectionShutdown).toHaveBeenCalledOnce();
  expect(primaryShutdown).not.toHaveBeenCalled();
  await owner.stop?.(ctx);
});
