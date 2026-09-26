/**
 * ACPX plugin service lifecycle. It resolves config, prepares isolated adapter
 * wrappers, registers the ACP backend, and manages startup/cleanup probes.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../runtime-api.js";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { DEFAULT_ACPX_TIMEOUT_SECONDS } from "./config-schema.js";
import {
  resolveAcpxPluginConfig,
  toAcpMcpServers,
  type ResolvedAcpxPluginConfig,
} from "./config.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
  reapStaleOpenClawOwnedAcpxOrphans,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";
import { AcpxRuntime } from "./runtime.js";
import { adoptAcpxStateDirectory } from "./session-owner-migration.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  normalizeAcpxGatewayInstanceRecord,
  type AcpxGatewayInstanceRecord,
} from "./state.js";

type AcpxRuntimeLike = CompleteAcpRuntime & {
  isHealthy(): boolean;
};
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const SKIP_RUNTIME_PROBE_ENV = "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE";
const MAX_ACPX_TOKIO_WORKER_THREADS = 8;

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  getProbeAgent: () => string | undefined;
  gatewayInstanceId: string;
  processLeaseStore: AcpxProcessLeaseStore;
  wrapperRoot: string;
  logger?: PluginLogger;
};

type AcpxBackendLifecycle = {
  publish: (backend: { runtime: CompleteAcpRuntime; healthy?: () => boolean }) => void;
  retract: (runtime: CompleteAcpRuntime) => void;
};

type CreateAcpxRuntimeServiceParams = {
  probeAtStartup?: boolean;
  startupPurpose?: "gateway" | "inspection";
  assertCurrent?: () => void;
  backendLifecycle: AcpxBackendLifecycle;
  pluginConfig?: unknown;
  getAllowedAgents?: () => readonly string[] | undefined;
  openKeyedStore?: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike | Promise<AcpxRuntimeLike>;
  processCleanupDeps?: AcpxProcessCleanupDeps;
};

function resolveAcpxTimerTimeoutMs(timeoutSeconds: number | undefined): number | undefined {
  if (timeoutSeconds === undefined) {
    return undefined;
  }
  return finiteSecondsToTimerSafeMilliseconds(timeoutSeconds) ?? 1;
}

function resolveAgentProcessEnv(): Record<string, string> | undefined {
  if (process.env.TOKIO_WORKER_THREADS?.trim()) {
    return undefined;
  }
  // Each managed ACP child owns a Tokio pool; cap its implicit host-wide default
  // so concurrent children do not multiply the Gateway's scheduler footprint.
  return {
    TOKIO_WORKER_THREADS: String(Math.min(availableParallelism(), MAX_ACPX_TOKIO_WORKER_THREADS)),
  };
}

async function createDefaultRuntime(params: AcpxRuntimeFactoryParams): Promise<AcpxRuntimeLike> {
  // Snapshot filenames once under the service owner. Runtime never migrates or reads legacy payloads.
  const names = await fs
    .readdir(path.join(params.pluginConfig.stateDir, "sessions"))
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const legacyBareSessionKeys = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const recordId = decodeURIComponent(name.slice(0, -5));
    if (
      !recordId.startsWith("agent:") &&
      !recordId.startsWith(".openclaw-owner-") &&
      !recordId.includes(":oneshot:")
    ) {
      legacyBareSessionKeys.add(recordId.toLowerCase());
    }
  }
  return new AcpxRuntime({
    cwd: params.pluginConfig.cwd,
    agentProcessEnv: resolveAgentProcessEnv(),
    openclawLegacyBareSessionKeys: legacyBareSessionKeys,
    openclawGatewayInstanceId: params.gatewayInstanceId,
    openclawProcessLeaseStore: params.processLeaseStore,
    openclawWrapperRoot: params.wrapperRoot,
    sessionStore: createFileSessionStore({ stateDir: params.pluginConfig.stateDir }),
    agentRegistry: createAgentRegistry({ overrides: params.pluginConfig.agents }),
    getProbeAgent: params.getProbeAgent,
    mcpServers: toAcpMcpServers(params.pluginConfig.mcpServers),
    pluginToolsMcpBridgeEnabled: params.pluginConfig.pluginToolsMcpBridge,
    openclawToolsMcpBridgeEnabled: params.pluginConfig.openClawToolsMcpBridge,
    permissionMode: params.pluginConfig.permissionMode,
    nonInteractivePermissions: params.pluginConfig.nonInteractivePermissions,
    elicitationModes: ["form", "url"],
    timeoutMs: resolveAcpxTimerTimeoutMs(params.pluginConfig.timeoutSeconds),
  });
}

function formatDoctorFailureMessage(report: { message: string; details?: string[] }): string {
  const detailText = report.details
    ?.map((detail) => detail.trim())
    .filter(Boolean)
    .join("; ");
  return detailText ? `${report.message} (${detailText})` : report.message;
}

async function measureAcpxStartup<T>(
  ctx: OpenClawPluginServiceContext,
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  return ctx.startupTrace ? await ctx.startupTrace.measure(name, run) : await run();
}

function shouldProbeRuntimeAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENABLE_STARTUP_PROBE_ENV] !== "0" && env[SKIP_RUNTIME_PROBE_ENV] !== "1";
}

async function withStartupProbeTimeout<T>(params: {
  promise: Promise<T>;
  timeoutSeconds: number;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = resolveAcpxTimerTimeoutMs(params.timeoutSeconds) ?? 1;
  try {
    return await Promise.race([
      params.promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `embedded acpx runtime backend startup probe timed out after ${params.timeoutSeconds}s`,
            ),
          );
        }, timeoutMs);
        (timeout as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function openGatewayInstanceStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): PluginStateKeyedStore<AcpxGatewayInstanceRecord> {
  return openKeyedStore<AcpxGatewayInstanceRecord>({
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  });
}

async function resolveGatewayInstanceId(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): Promise<string> {
  const store = openGatewayInstanceStateStore(openKeyedStore);
  const existing = normalizeAcpxGatewayInstanceRecord(
    await store.lookup(ACPX_GATEWAY_INSTANCE_KEY),
  );
  if (existing) {
    return existing.instanceId;
  }
  const next = randomUUID();
  await store.register(ACPX_GATEWAY_INSTANCE_KEY, {
    instanceId: next,
    createdAt: Date.now(),
  });
  return next;
}

async function reapOpenAcpxProcessLeases(params: {
  gatewayInstanceId: string;
  leaseStore: AcpxProcessLeaseStore;
  deps?: AcpxProcessCleanupDeps;
  assertCurrent?: () => void;
}): Promise<{ inspectedPids: number[]; terminatedPids: number[] }> {
  const assertCurrent = () => {
    params.assertCurrent?.();
    params.deps?.assertCurrent?.();
  };
  const deps = { ...params.deps, assertCurrent };
  const leases = await params.leaseStore.listOpen(params.gatewayInstanceId);
  const inspectedPids: number[] = [];
  const terminatedPids: number[] = [];
  const legacyWrapperRoots = new Set<string>();
  for (const lease of leases) {
    if (lease.rootPid <= 0) {
      legacyWrapperRoots.add(lease.wrapperRoot);
      assertCurrent();
      await params.leaseStore.markState(lease.leaseId, "closing");
      assertCurrent();
      const result = await cleanupOpenClawOwnedAcpxPendingLease({
        leaseId: lease.leaseId,
        gatewayInstanceId: lease.gatewayInstanceId,
        wrapperRoot: lease.wrapperRoot,
        wrapperPath: lease.wrapperPath,
        deps,
      });
      inspectedPids.push(...result.inspectedPids);
      terminatedPids.push(...result.terminatedPids);
      // A missing probe wrapper cannot prove its detached adapter descendants
      // exited because those descendants do not carry the lease arguments.
      const retryableEvidenceFailure =
        result.skippedReason === "ambiguous-root" ||
        result.skippedReason === "process-list-unavailable" ||
        result.skippedReason === "unsupported-platform" ||
        result.skippedReason === "unverified-root" ||
        (lease.sessionKey === ACPX_PROBE_LEASE_SESSION_KEY &&
          result.skippedReason === "missing-root");
      assertCurrent();
      await params.leaseStore.markState(
        lease.leaseId,
        retryableEvidenceFailure ? "open" : result.terminatedPids.length > 0 ? "closed" : "lost",
      );
      continue;
    }
    assertCurrent();
    await params.leaseStore.markState(lease.leaseId, "closing");
    assertCurrent();
    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: lease.rootPid,
      expectedLeaseId: lease.leaseId,
      expectedGatewayInstanceId: lease.gatewayInstanceId,
      wrapperRoot: lease.wrapperRoot,
      deps,
    });
    inspectedPids.push(...result.inspectedPids);
    terminatedPids.push(...result.terminatedPids);
    assertCurrent();
    await params.leaseStore.markState(
      lease.leaseId,
      result.skippedReason === "process-list-unavailable" ||
        result.skippedReason === "unsupported-platform"
        ? "open"
        : result.terminatedPids.length > 0
          ? "closed"
          : "lost",
    );
  }
  // Preserve the previous narrow trigger for marker cleanup: a pending lease
  // proves this Gateway had an uncertain spawn. Keep aggregate results wholly
  // separate from the state transition of any specific lease.
  for (const wrapperRoot of legacyWrapperRoots) {
    assertCurrent();
    const legacyResult = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot,
      deps,
    });
    inspectedPids.push(...legacyResult.inspectedPids);
    terminatedPids.push(...legacyResult.terminatedPids);
  }
  return { inspectedPids, terminatedPids };
}

/** Create the ACPX plugin service that owns runtime registration and cleanup. */
export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams,
): OpenClawPluginService & {
  promote(ctx: OpenClawPluginServiceContext, assertCurrent?: () => void): Promise<void>;
} {
  let runtime: AcpxRuntimeLike | null = null;
  let recoverProcesses:
    | ((
        assertCurrent: () => void,
      ) => Promise<{ inspectedPids: number[]; terminatedPids: number[] }>)
    | undefined;
  let recoveryPromise: Promise<void> | undefined;
  let lifecycleRevision = 0;

  const promote = async (ctx: OpenClawPluginServiceContext, assertOwner = params.assertCurrent) => {
    const recover = recoverProcesses;
    if (!recover) {
      throw new Error("ACPX runtime service is not initialized");
    }
    const revision = lifecycleRevision;
    const assertCurrent = () => {
      if (revision !== lifecycleRevision || recoverProcesses !== recover) {
        throw new Error("ACPX runtime service stopped during recovery");
      }
      assertOwner?.();
    };
    assertCurrent();
    recoveryPromise ??= measureAcpxStartup(ctx, "process-leases.reap", async () => {
      const result = await recover(assertCurrent);
      assertCurrent();
      if (result.terminatedPids.length > 0) {
        ctx.logger.info(
          `reaped ${result.terminatedPids.length} stale OpenClaw-owned ACPX processes`,
        );
      }
    });
    await recoveryPromise;
    assertCurrent();
  };

  return {
    id: "acpx-runtime",
    promote,
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
        ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
        return;
      }
      const openKeyedStore = params.openKeyedStore;
      if (!openKeyedStore) {
        throw new Error("ACPX runtime service requires plugin keyed state");
      }

      const basePluginConfig = await measureAcpxStartup(ctx, "config.resolve", () =>
        resolveAcpxPluginConfig({
          rawConfig: params.pluginConfig,
          workspaceDir: ctx.workspaceDir,
          stateDir: ctx.stateDir,
        }),
      );
      const adoption = await measureAcpxStartup(ctx, "state.adopt", () =>
        adoptAcpxStateDirectory({
          rawConfig: params.pluginConfig,
          workspaceDir: ctx.workspaceDir,
          stateDir: basePluginConfig.stateDir,
          openKeyedStore,
          assertCurrent: params.assertCurrent,
        }),
      );
      basePluginConfig.stateDir = adoption.stateDir;
      for (const change of adoption.changes) {
        ctx.logger.info(change);
      }
      for (const warning of adoption.warnings) {
        ctx.logger.warn(warning);
      }
      const pluginConfig = await measureAcpxStartup(ctx, "config.prepare-codex-auth", () =>
        prepareAcpxCodexAuthConfig({
          pluginConfig: basePluginConfig,
          stateDir: ctx.stateDir,
          logger: ctx.logger,
        }),
      );
      const wrapperRoot = path.join(ctx.stateDir, "acpx");
      await measureAcpxStartup(ctx, "filesystem.prepare", async () => {
        await fs.mkdir(pluginConfig.stateDir, { recursive: true });
        await fs.mkdir(wrapperRoot, { recursive: true });
      });
      const gatewayInstanceId = await measureAcpxStartup(ctx, "gateway-instance-id", () =>
        resolveGatewayInstanceId(openKeyedStore),
      );
      const processLeaseStore = createAcpxProcessLeaseStore({
        store: openAcpxProcessLeaseStateStore(openKeyedStore),
      });
      recoverProcesses = (assertCurrent) =>
        reapOpenAcpxProcessLeases({
          gatewayInstanceId,
          leaseStore: processLeaseStore,
          deps: params.processCleanupDeps,
          assertCurrent,
        });
      if (params.startupPurpose !== "inspection") {
        await promote(ctx);
      }
      const getAllowedAgents = params.getAllowedAgents ?? (() => ctx.config.acp?.allowedAgents);
      const getProbeAgent = () =>
        pluginConfig.probeAgent ??
        getAllowedAgents()?.map(normalizeLowercaseStringOrEmpty).find(Boolean);
      const startedRuntime = await measureAcpxStartup(ctx, "runtime.create", () =>
        (params.runtimeFactory ?? createDefaultRuntime)({
          pluginConfig,
          getProbeAgent,
          gatewayInstanceId,
          processLeaseStore,
          wrapperRoot,
          logger: ctx.logger,
        }),
      );
      runtime = startedRuntime;

      const shouldProbeRuntime = params.probeAtStartup !== false && shouldProbeRuntimeAtStartup();
      ctx.startupTrace?.detail?.("probe-policy", [
        ["startupProbeEnabledCount", shouldProbeRuntime ? 1 : 0],
        ["probeAgent", getProbeAgent() ?? "default"],
      ]);
      await measureAcpxStartup(ctx, "backend.register", () => {
        const backend = {
          runtime: startedRuntime,
          ...(shouldProbeRuntime ? { healthy: () => runtime?.isHealthy() ?? false } : {}),
        };
        params.backendLifecycle.publish(backend);
        ctx.logger.info(`embedded acpx runtime backend registered (cwd: ${pluginConfig.cwd})`);
      });

      if (!shouldProbeRuntime) {
        return;
      }

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      try {
        const doctorReport = await measureAcpxStartup(ctx, "probe.availability", () =>
          withStartupProbeTimeout({
            promise: startedRuntime.doctor(),
            timeoutSeconds: pluginConfig.timeoutSeconds ?? DEFAULT_ACPX_TIMEOUT_SECONDS,
          }),
        );
        if (currentRevision !== lifecycleRevision) {
          return;
        }
        if (doctorReport.ok) {
          ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 1]]);
          ctx.logger.info("embedded acpx runtime backend ready");
          return;
        }
        ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 0]]);
        ctx.logger.warn(
          `embedded acpx runtime backend probe failed: ${formatDoctorFailureMessage(doctorReport)}`,
        );
      } catch (err) {
        if (currentRevision !== lifecycleRevision) {
          return;
        }
        ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 0]]);
        ctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage(err)}`);
      }
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      if (runtime) {
        params.backendLifecycle.retract(runtime);
        const [shutdown] = await Promise.allSettled([runtime.shutdown(), recoveryPromise]);
        if (shutdown.status === "rejected") {
          throw shutdown.reason;
        }
      } else {
        await recoveryPromise?.catch(() => undefined);
      }
      runtime = null;
      recoverProcesses = undefined;
      recoveryPromise = undefined;
    },
  };
}
