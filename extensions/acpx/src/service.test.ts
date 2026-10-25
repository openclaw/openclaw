import fs from "node:fs/promises";
import path from "node:path";
import { createFileSessionStore } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
import { stateMigrations } from "../doctor-contract-api.js";
import { createEmptyAcpxKeyedStore } from "./empty-keyed-store.test-support.js";
import { AcpxRuntime } from "./runtime.js";

type CleanupResult = Awaited<
  ReturnType<(typeof import("./process-reaper.js"))["cleanupOpenClawOwnedAcpxProcessTree"]>
>;
type CleanupParams = Parameters<
  (typeof import("./process-reaper.js"))["cleanupOpenClawOwnedAcpxProcessTree"]
>[0];
type RuntimeFactory = (
  options: ConstructorParameters<typeof AcpxRuntime>[0],
) => Pick<AcpxRuntime, "doctor" | "shutdown" | "isHealthy">;

const {
  runtimeRegistry,
  availableParallelismMock,
  prepareAcpxCodexAuthConfigMock,
  cleanupOpenClawOwnedAcpxProcessTreeMock,
  cleanupOpenClawOwnedAcpxPendingLeaseMock,
  reapStaleOpenClawOwnedAcpxOrphansMock,
  acpxRuntimeConstructorMock,
  createAgentRegistryMock,
  createFileSessionStoreMock,
} = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
  availableParallelismMock: vi.fn(() => 4),
  prepareAcpxCodexAuthConfigMock: vi.fn(
    async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig,
  ),
  cleanupOpenClawOwnedAcpxProcessTreeMock: vi.fn<(params: CleanupParams) => Promise<CleanupResult>>(
    async () => ({ terminatedPids: [] }),
  ),
  cleanupOpenClawOwnedAcpxPendingLeaseMock: vi.fn(async (): Promise<CleanupResult> => ({
    terminatedPids: [],
    skippedReason: "missing-root",
  })),
  reapStaleOpenClawOwnedAcpxOrphansMock: vi.fn(async (): Promise<CleanupResult> => ({
    terminatedPids: [],
  })),
  acpxRuntimeConstructorMock: vi.fn<RuntimeFactory>(),
  createAgentRegistryMock: vi.fn(() => ({})),
  createFileSessionStoreMock: vi.fn(() => ({})),
}));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: availableParallelismMock,
}));

vi.mock("acpx/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("acpx/runtime")>();
  return { ...actual, createFileSessionStore: vi.fn(actual.createFileSessionStore) };
});

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
let ctx: OpenClawPluginServiceContext;
let runtime: ReturnType<typeof createMockRuntime>;

beforeEach(async () => {
  acpxRuntimeConstructorMock.mockReset();
  acpxRuntimeConstructorMock.mockImplementation(function MockAcpxRuntime() {
    return runtime;
  });
  testWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-acpx-service-",
  });
  ctx = createServiceContext(testWorkspace.dir);
  runtime = createMockRuntime();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  runtimeRegistry.clear();
  vi.clearAllMocks();
  availableParallelismMock.mockReturnValue(4);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

function createOpenKeyedStore(context: OpenClawPluginServiceContext) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: context.stateDir };
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("acpx", {
      ...options,
      env: options.env ?? env,
    });
}

type ServiceParams = Parameters<typeof createRealAcpxRuntimeService>[0];
function createAcpxRuntimeService(
  context: OpenClawPluginServiceContext,
  params: Omit<ServiceParams, "backendLifecycle" | "openKeyedStore"> &
    Partial<Pick<ServiceParams, "backendLifecycle" | "openKeyedStore">> = {},
) {
  const backendLifecycle = params.backendLifecycle ?? {
    publish(backend: { runtime: unknown; healthy?: () => boolean }) {
      runtimeRegistry.set("acpx", backend);
    },
    retract(ownedRuntime: unknown) {
      if (runtimeRegistry.get("acpx")?.runtime === ownedRuntime) {
        runtimeRegistry.delete("acpx");
      }
    },
  };
  return createRealAcpxRuntimeService({
    ...params,
    backendLifecycle,
    openKeyedStore: params.openKeyedStore ?? createOpenKeyedStore(context),
  });
}

function openGatewayInstanceStore(context: OpenClawPluginServiceContext) {
  return createOpenKeyedStore(context)<AcpxGatewayInstanceRecord>({
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  });
}

function openProcessLeaseStore(context: OpenClawPluginServiceContext) {
  return openAcpxProcessLeaseStateStore(createOpenKeyedStore(context));
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    shutdown: vi.fn(async () => {}),
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

function failDirectoryRead(directory: string, message: string) {
  const readdir = fs.readdir.bind(fs);
  vi.spyOn(fs, "readdir").mockImplementation((...args) =>
    args[0] === directory
      ? Promise.reject(Object.assign(new Error(message), { code: "EACCES" }))
      : readdir(...args),
  );
}

async function seedActiveLease(
  context: OpenClawPluginServiceContext,
  overrides: Partial<AcpxProcessLease> = {},
) {
  const wrapperRoot = path.join(context.stateDir, "acpx");
  await openGatewayInstanceStore(context).register(ACPX_GATEWAY_INSTANCE_KEY, {
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
  await openProcessLeaseStore(context).register(lease.leaseId, lease);
  return lease;
}

describe("createAcpxRuntimeService", () => {
  it.each(["absent", "occupied", "move-failed", "marker-failed", "destination-unreadable"])(
    "preserves legacy sessions at startup with a %s destination",
    async (scenario) => {
      const legacy = path.join(testWorkspace.dir, "state");
      const destination = path.join(ctx.stateDir, "acpx");
      const recordId = "agent:main:acp:retained";
      const recordPath = path.join(legacy, "sessions", `${encodeURIComponent(recordId)}.json`);
      await fs.mkdir(path.dirname(recordPath), { recursive: true });
      await fs.writeFile(
        recordPath,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: recordId,
          acp_session_id: "upstream-retained",
          agent_command: "fixture",
          cwd: testWorkspace.dir,
          name: recordId,
          created_at: "2026-09-01T00:00:00.000Z",
          last_used_at: "2026-09-01T00:00:00.000Z",
          last_seq: 0,
          messages: [],
          updated_at: "2026-09-01T00:00:00.000Z",
        }),
      );
      await fs.writeFile(path.join(legacy, "retained-history.bin"), "opaque history");
      const original = await createFileSessionStore({ stateDir: legacy }).load(recordId);
      expect(original?.acpSessionId).toBe("upstream-retained");
      if (scenario === "occupied") {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "existing"), "do not overwrite");
      }
      if (scenario === "move-failed") {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
          if (source === legacy) {
            throw Object.assign(new Error("fixture move failure"), {
              code: "EACCES",
            });
          }
          return rename(source, target);
        });
      }
      if (scenario === "destination-unreadable") {
        await fs.mkdir(ctx.stateDir, { recursive: true });
        await fs.rename(legacy, destination);
        failDirectoryRead(destination, "fixture unreadable");
      }
      const sessionStores = vi.mocked(createFileSessionStore);
      const selected = () => sessionStores.mock.calls.at(-1)![0].stateDir;
      let markerWrites = 0;
      const openKeyedStore = createOpenKeyedStore(ctx);
      const service = createAcpxRuntimeService(ctx, {
        pluginConfig: {},
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
          const store = openKeyedStore<T>(options);
          if (scenario === "marker-failed" && options.namespace === "state-directory-migration") {
            const register = store.register;
            store.register = async (...args) => {
              if (++markerWrites === 2) {
                throw new Error("fixture marker write failure");
              }
              return register(...args);
            };
          }
          return store;
        },
        probeAtStartup: false,
      });
      try {
        await service.start(ctx);
        const retained = scenario === "move-failed";
        expect(selected()).toBe(retained ? legacy : destination);
        if (scenario === "occupied") {
          expect(await fs.readFile(recordPath, "utf8")).toContain("upstream-retained");
          expect(await fs.readFile(path.join(destination, "existing"), "utf8")).toBe(
            "do not overwrite",
          );
        } else {
          expect(await createFileSessionStore({ stateDir: selected() }).load(recordId)).toEqual(
            original,
          );
          expect(await fs.readFile(path.join(selected(), "retained-history.bin"), "utf8")).toBe(
            "opaque history",
          );
        }
        if (!retained && scenario !== "occupied" && scenario !== "destination-unreadable") {
          await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
          expect(ctx.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Migrated ACPX session state"),
          );
        }
        if (scenario === "move-failed") {
          expect(ctx.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("plugins.entries.acpx.config.stateDir"),
          );
          await service.stop?.(ctx);
          await fs.writeFile(path.join(destination, "adapter-wrapper"), "generated wrapper");
          await service.start(ctx);
          expect(selected()).toBe(legacy);
        }
        if (scenario === "marker-failed") {
          expect(ctx.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("fixture marker write failure"),
          );
          await service.stop?.(ctx);
          await service.start(ctx);
          expect(ctx.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Completed ACPX session state adoption"),
          );
        }
        if (scenario === "absent" || scenario === "marker-failed") {
          await service.stop?.(ctx);
          await fs.rename(destination, path.join(ctx.stateDir, "saved-adoption"));
          await fs.mkdir(path.dirname(recordPath), { recursive: true });
          await fs.writeFile(recordPath, "stale source must not be adopted twice");
          failDirectoryRead(path.join(legacy, "sessions"), "stale legacy directory is unreadable");
          await service.start(ctx);
          expect(selected()).toBe(destination);
          expect(await fs.readFile(recordPath, "utf8")).toBe(
            "stale source must not be adopted twice",
          );
          expect(await fs.readdir(destination)).toEqual([]);
          const migration = stateMigrations.find(
            (item) => item.id === "acpx-session-owner-resources",
          )!;
          expect(
            await migration.detectLegacyState({
              config: {},
              env: { ...process.env, OPENCLAW_STATE_DIR: ctx.stateDir },
              stateDir: ctx.stateDir,
              serviceWorkspaceDir: ctx.workspaceDir,
              oauthDir: path.join(ctx.stateDir, "oauth"),
              context: { openPluginStateKeyedStore: openKeyedStore },
            }),
          ).toBeNull();
        }
      } finally {
        await service.stop?.(ctx);
      }
    },
  );

  it("publishes before probing and retracts the exact runtime through the injected lifecycle", async () => {
    vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", undefined);
    const probeStarted = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    const events: string[] = [];
    runtime = createMockRuntime({
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
      openKeyedStore: createEmptyAcpxKeyedStore,
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

  it("skips startup probe and health when the skip flag overrides startup", async () => {
    vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", "1");
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE", "1");
    const stateDir = path.join(testWorkspace.dir, "custom-state");
    runtime = createMockRuntime({ isHealthy: () => false });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { stateDir },
      openKeyedStore: createEmptyAcpxKeyedStore,
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
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await seedActiveLease(ctx, {
      leaseId: "lease-1",
      sessionKey: "agent:codex:acp:test",
      rootPid: 101,
    });
    cleanupOpenClawOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      terminatedPids: [101, 102],
    });
    const service = createAcpxRuntimeService(ctx);

    await service.start(ctx);

    expect(cleanupOpenClawOwnedAcpxProcessTreeMock).toHaveBeenCalledWith({
      rootPid: 101,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gw-test",
      wrapperRoot,
      assertCurrent: expect.any(Function),
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale OpenClaw-owned ACPX processes");

    await service.stop?.(ctx);
  });

  it("keeps an absent pending probe lease open for unidentifiable descendants", async () => {
    const lease = await seedActiveLease(ctx, {
      leaseId: "lease-probe-missing",
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      rootPid: 0,
    });
    const service = createAcpxRuntimeService(ctx);

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("snapshots legacy session ownership when acquiring a runtime without probing", async () => {
    vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", "0");
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME_PROBE", undefined);
    const service = createAcpxRuntimeService(ctx, { openKeyedStore: createEmptyAcpxKeyedStore });
    const sessionsDir = path.join(ctx.stateDir, "acpx", "sessions");
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
    { override: undefined, expected: { TOKIO_WORKER_THREADS: "8" } },
    { override: "12", expected: undefined },
  ])(
    "bounds default ACPX workers but preserves explicit override $override",
    async ({ override, expected }) => {
      vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", "0");
      vi.stubEnv("TOKIO_WORKER_THREADS", override);
      availableParallelismMock.mockReturnValue(64);
      const service = createAcpxRuntimeService(ctx, { openKeyedStore: createEmptyAcpxKeyedStore });

      await service.start(ctx);

      expect(acpxRuntimeConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ agentProcessEnv: expected }),
      );
      await service.stop?.(ctx);
    },
  );

  it("bounds startup diagnostics after an unhealthy probe", async () => {
    vi.stubEnv("OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE", "1");
    const doctorStarted = createDeferred<void>();
    const releaseDoctor = createDeferred<{ ok: boolean; message: string }>();
    runtime = createMockRuntime({
      isHealthy: () => false,
      doctor: vi.fn(() => {
        doctorStarted.resolve();
        return releaseDoctor.promise;
      }),
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
      openKeyedStore: createEmptyAcpxKeyedStore,
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
      expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(false);
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        "embedded acpx runtime setup failed: embedded acpx runtime backend startup check timed out after 0.001s",
      );
    } finally {
      releaseDoctor.resolve({ ok: false, message: "unavailable" });
      await started;
      await service.stop?.(ctx);
      vi.useRealTimers();
    }
  });

  it("resolves the current allowed agent and the default timeout", async () => {
    ctx.config = { acp: { allowedAgents: ["claude"] } };
    let currentAllowedAgents: readonly string[] | undefined;
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: {},
      openKeyedStore: createEmptyAcpxKeyedStore,
      getAllowedAgents: () => currentAllowedAgents,
    });
    try {
      await service.start(ctx);
      const input = acpxRuntimeConstructorMock.mock.calls[0]![0];
      expect(input.timeoutMs).toBe(120_000);
      expect(input.getProbeAgent?.()).toBeUndefined();
      currentAllowedAgents = ["gemini"];
      expect(input.getProbeAgent?.()).toBe("gemini");
      currentAllowedAgents = undefined;
      expect(input.getProbeAgent?.()).toBeUndefined();
      expect(runtime.shutdown).not.toHaveBeenCalled();
    } finally {
      await service.stop?.(ctx);
    }
  });

  it("can skip the embedded runtime backend via env", async () => {
    vi.stubEnv("OPENCLAW_SKIP_ACPX_RUNTIME", "1");
    const service = createAcpxRuntimeService(ctx);

    await service.start(ctx);

    expect(acpxRuntimeConstructorMock).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)",
    );
  });
});

it("catalog-only acquisition and disposal preserve another active runtime lease", async () => {
  await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
    instanceId: "gw-test",
    createdAt: 1,
  });
  const primary = createRuntimeWithoutProcesses();
  const primaryShutdown = vi.spyOn(primary, "shutdown");
  acpxRuntimeConstructorMock.mockImplementationOnce(function MockAcpxRuntime() {
    return primary;
  });
  const owner = createAcpxRuntimeService(ctx, {
    probeAtStartup: false,
  });
  await owner.start(ctx);
  const lease = await seedActiveLease(ctx);
  const inspectionRuntime = createRuntimeWithoutProcesses();
  const inspectionShutdown = vi.spyOn(inspectionRuntime, "shutdown");
  acpxRuntimeConstructorMock.mockImplementationOnce(function MockAcpxRuntime() {
    return inspectionRuntime;
  });
  const inspection = createAcpxRuntimeService(ctx, {
    startupPurpose: "inspection",
    probeAtStartup: false,
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
