import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { acpxRuntimeConstructorMock, createAgentRegistryMock, createSqliteSessionStoreMock } =
  vi.hoisted(() => ({
    acpxRuntimeConstructorMock: vi.fn(function AcpxRuntime(options: unknown) {
      return {
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
        ensureSession: vi.fn(async () => ({
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:test",
          sessionKey: "agent:codex:acp:test",
        })),
        getCapabilities: vi.fn(async () => ({ controls: [] })),
        getStatus: vi.fn(async () => ({ summary: "ready" })),
        isHealthy: vi.fn(() => true),
        prepareFreshSession: vi.fn(async () => {}),
        probeAvailability: vi.fn(async () => {}),
        runTurn: vi.fn(async function* () {}),
        setConfigOption: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        __options: options,
      };
    }),
    createAgentRegistryMock: vi.fn(() => ({})),
    createSqliteSessionStoreMock: vi.fn(() => ({})),
  }));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
  registerAcpRuntimeBackend: (entry: { id: string; runtime: unknown; healthy?: () => boolean }) => {
    runtimeRegistry.set(entry.id, entry);
  },
  unregisterAcpRuntimeBackend: (id: string) => {
    runtimeRegistry.delete(id);
  },
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: acpxRuntimeConstructorMock,
  createAgentRegistry: createAgentRegistryMock,
  createSqliteSessionStore: createSqliteSessionStoreMock,
}));

vi.mock("./codex-auth-bridge.js", () => ({
  prepareAcpxCodexAuthConfig: prepareAcpxCodexAuthConfigMock,
}));

vi.mock("./process-reaper.js", () => ({
  cleanupOpenClawOwnedAcpxProcessTree: cleanupOpenClawOwnedAcpxProcessTreeMock,
  reapStaleOpenClawOwnedAcpxOrphans: reapStaleOpenClawOwnedAcpxOrphansMock,
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import { createAcpxProcessLeaseStore } from "./process-lease.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  ACPX_GATEWAY_INSTANCE_PLUGIN_ID,
  createAcpxRuntimeService,
  resolveAcpxWrapperRoot,
} from "./service.js";

type GatewayInstanceRecord = {
  version: 1;
  id: string;
  createdAt: number;
};

const gatewayInstanceStore = createPluginStateKeyedStore<GatewayInstanceRecord>(
  ACPX_GATEWAY_INSTANCE_PLUGIN_ID,
  {
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: 1,
  },
);

const tempDirs: string[] = [];
const previousEnv = {
  OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE,
  OPENCLAW_SKIP_ACPX_RUNTIME: process.env.OPENCLAW_SKIP_ACPX_RUNTIME,
  OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  runtimeRegistry.clear();
  prepareAcpxCodexAuthConfigMock.mockClear();
  cleanupOpenClawOwnedAcpxProcessTreeMock.mockClear();
  reapStaleOpenClawOwnedAcpxOrphansMock.mockClear();
  acpxRuntimeConstructorMock.mockClear();
  createAgentRegistryMock.mockClear();
  createSqliteSessionStoreMock.mockClear();
  restoreEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME");
  restoreEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE");
  restoreEnv("OPENCLAW_STATE_DIR");
  resetPluginStateStoreForTests();
  await fs.rm(resolveAcpxWrapperRoot(), { recursive: true, force: true });
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function createServiceContext(workspaceDir: string) {
  const stateDir = path.join(workspaceDir, ".openclaw-plugin-state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return {
    workspaceDir,
    stateDir,
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
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

async function writeGatewayInstanceIdFixture(id: string): Promise<void> {
  await gatewayInstanceStore.register(ACPX_GATEWAY_INSTANCE_KEY, {
    version: 1,
    id,
    createdAt: Date.now(),
  });
}

describe("createAcpxRuntimeService", () => {
  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("skips the startup probe and defers acpx backend health reporting when explicitly opted out", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const runtime = createMockRuntime({
      doctor: async () => ({ ok: true, message: "ok" }),
      isHealthy: () => true,
      probeAvailability,
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("waits for the embedded runtime startup probe before resolving", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    let releaseProbe!: () => void;
    const probeStarted = vi.fn();
    const probeAvailability = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          probeStarted();
          releaseProbe = resolve;
        }),
    );
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    const startPromise = service.start(ctx) as Promise<void>;
    await vi.waitFor(() => {
      expect(probeStarted).toHaveBeenCalledOnce();
    });

    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    releaseProbe();
    await startPromise;

    expect(resolved).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalledWith("embedded acpx runtime backend ready");

    await service.stop?.(ctx);
  });

  it("reaps stale ACPX process leases from the generated wrapper root at startup", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = resolveAcpxWrapperRoot();
    const processLeaseStore = createAcpxProcessLeaseStore();
    await fs.mkdir(wrapperRoot, { recursive: true });
    await writeGatewayInstanceIdFixture("gw-test");
    await processLeaseStore.save({
      leaseId: "lease-1",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [101, 102],
      terminatedPids: [101, 102],
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).toHaveBeenCalledWith({
      rootPid: 101,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gw-test",
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");

    await service.stop?.(ctx);
  });

  it("runs wrapper-root orphan cleanup before dropping pending ACPX leases", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = resolveAcpxWrapperRoot();
    const processLeaseStore = createAcpxProcessLeaseStore();
    await fs.mkdir(wrapperRoot, { recursive: true });
    await writeGatewayInstanceIdFixture("gw-test");
    await processLeaseStore.save({
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    });
    reapStaleOpenClawOwnedAcpxOrphansMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [201, 202],
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
    expect(reapStaleOpenClawOwnedAcpxOrphansMock).toHaveBeenCalledWith({
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");
    await expect(processLeaseStore.load("lease-pending")).resolves.toMatchObject({
      state: "closed",
    });

    await service.stop?.(ctx);
  });

  it("keeps startup quiet when no process leases are open", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("registers the default backend lazily without importing ACPX runtime when startup probing is opted out", async () => {
    process.env.OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService();

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };
    expect(typeof backendRuntime.ensureSession).toBe("function");
    expect(acpxRuntimeConstructorMock).not.toHaveBeenCalled();

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    expect(acpxRuntimeConstructorMock).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("runs the embedded runtime probe at startup by default and reports health", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(true);

    await service.stop?.(ctx);
  });

  it("bounds the embedded runtime startup probe wait with the configured timeout", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(() => new Promise<void>(() => {}));
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService({
      pluginConfig: { timeoutSeconds: 0.001 },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "embedded acpx runtime setup failed: embedded acpx runtime backend startup probe timed out after 0.001s",
    );

    await service.stop?.(ctx);
  });

  it("passes the default runtime timeout to the embedded runtime factory", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.timeoutSeconds).toBe(120);

    await service.stop?.(ctx);
  });

  it("forwards a configured probeAgent to the runtime factory so the probe does not hardcode the default", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = {
      ensureSession: vi.fn(),
      runTurn: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
      probeAvailability: vi.fn(async () => {}),
      isHealthy: vi.fn(() => true),
      doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    };
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      pluginConfig: { probeAgent: "opencode" },
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("opencode");

    await service.stop?.(ctx);
  });

  it("uses the first allowed ACP agent as the default probe agent", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["  OpenCode  ", "codex"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("opencode");

    await service.stop?.(ctx);
  });

  it("keeps explicit probeAgent ahead of acp.allowedAgents", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["opencode"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService({
      pluginConfig: { probeAgent: "codex" },
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("codex");

    await service.stop?.(ctx);
  });

  it("warns when legacy compatibility config is explicitly ignored", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService({
      pluginConfig: {
        queueOwnerTtlSeconds: 30,
        strictWindowsCmdWrapper: false,
      },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "embedded acpx runtime ignores legacy compatibility config: queueOwnerTtlSeconds, strictWindowsCmdWrapper=false",
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime probe via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const runtime = createMockRuntime({
      doctor: async () => ({ ok: false, message: "nope" }),
      isHealthy: () => false,
      probeAvailability,
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("formats non-string doctor details without losing object payloads", async () => {
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime({
      doctor: async () => ({
        ok: false,
        message: "probe failed",
        details: [{ code: "ACP_CLOSED", agent: "codex" }, new Error("stdin closed")],
      }),
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService({
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'embedded acpx runtime backend probe failed: probe failed ({"code":"ACP_CLOSED","agent":"codex"}; stdin closed)',
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime backend via env", async () => {
    process.env.OPENCLAW_SKIP_ACPX_RUNTIME = "1";
    const workspaceDir = await makeTempDir();
    const ctx = createServiceContext(workspaceDir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService({
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
