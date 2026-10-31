import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  hasAgentRunContextExecutionOwner,
  listAgentRunsForSession,
} from "../infra/agent-run-registry.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntimeManagerInstall } from "./agent-bundle-mcp-manager-install.js";
import {
  createSessionMcpRuntimeManagerLifecycle,
  type SessionMcpRuntimeManagerOpts,
  type SessionMcpConfigPublication,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import {
  SessionMcpRuntimeCapacityError,
  resolveSessionMcpRuntimeIdleTtlMs,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { revokeMcpAppModelContext } from "./mcp-app-model-context.js";
import {
  buildMcpRequesterRuntimeCacheKey,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";
import { resetMcpStartupBackoff } from "./mcp-startup-backoff.js";

type RuntimeAcquisitionParams = Parameters<SessionMcpRuntimeManager["acquire"]>[0];
type PreparedAcquisitionParams = RuntimeAcquisitionParams & {
  requester?: { runtimeKey: string; senderId: string };
};

const sessionMcpRuntimeLoader = createLazyImportLoader(
  () => import("./agent-bundle-mcp-runtime.js"),
);

// Peeking and retiring sessions need the manager, not its transport implementation.
const createSessionMcpRuntimeLazy: CreateSessionMcpRuntime = async (params) => {
  const runtime = await sessionMcpRuntimeLoader.load();
  return runtime.createSessionMcpRuntime(params);
};

export function createSessionMcpRuntimeManager(opts: SessionMcpRuntimeManagerOpts) {
  const lifecycle = createSessionMcpRuntimeManagerLifecycle(opts, createSessionMcpRuntimeLazy);
  const { store, catalogs } = lifecycle;
  const install = createSessionMcpRuntimeManagerInstall(lifecycle);
  const leaseRuntime = (
    runtime: SessionMcpRuntime,
    runtimeKey: string,
  ): SessionMcpRuntimeLease => ({
    runtime,
    releaseLease: runtime.acquireLease?.() ?? (() => {}),
    async retireUnusedServers(retainedServerNames) {
      const owner = sessionMcpRuntimeOwners.get(runtime);
      if (store.runtimesBySessionId.get(runtimeKey) !== runtime || !owner?.isCurrent()) {
        return;
      }
      await owner.retireUnusedServers(retainedServerNames);
      if (!owner.hasServers()) {
        await lifecycle.releaseEmptyRuntimeSlot(runtimeKey, runtime);
      }
    },
  });
  const acquireCurrent = <T extends SessionMcpRuntimeLease | undefined>(
    scope: "full" | "requester",
    acquire: (params: PreparedAcquisitionParams) => Promise<T>,
  ) =>
    async function current(params: RuntimeAcquisitionParams): Promise<T> {
      const senderId = normalizeOptionalString(params.requesterSenderId);
      const requester = senderId
        ? {
            senderId,
            runtimeKey: buildMcpRequesterRuntimeCacheKey({
              ...params,
              requesterSenderId: senderId,
            }),
          }
        : undefined;
      const runtimeKeys = requester ? [requester.runtimeKey] : [];
      if (scope === "full" || !requester) {
        runtimeKeys.push(params.sessionId);
      }
      const priorDisposal = store.disposalInFlight;
      const priorSessionWork = store.runtimeWorkChains.get(params.sessionId);
      const publication = store.configReload;
      let acquired: T | undefined;
      try {
        return await lifecycle.runExclusiveOnRuntimeKeys(runtimeKeys, async () => {
          await Promise.all([priorDisposal, priorSessionWork].filter((work) => work !== undefined));
          store.scheduler.signal.throwIfAborted();
          const reload = store.configReload;
          acquired = await acquire({
            ...params,
            requester,
            ...(reload && reload !== publication
              ? { cfg: reload.cfg, manifestRegistry: reload.manifestRegistry }
              : {}),
          });
          store.scheduler.signal.throwIfAborted();
          return acquired;
        });
      } catch (error) {
        acquired?.releaseLease();
        acquired = undefined;
        throw error;
      } finally {
        // Retirement may wait for this queue; complete it only after leaving it.
        if (!acquired) {
          await manager.completeDeferredRetirement(params.sessionId);
        }
      }
    };
  const createUnavailableRuntime = (
    params: RuntimeAcquisitionParams,
    error: SessionMcpRuntimeCapacityError,
    runtimeKey = params.sessionId,
  ): SessionMcpRuntime => {
    const rememberedCatalog = store.catalogByRuntimeKey.get(runtimeKey)?.catalog;
    if (error.notify && params.sessionKey) {
      for (const run of listAgentRunsForSession({
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
      })) {
        if (!hasAgentRunContextExecutionOwner(run.runId)) {
          continue;
        }
        emitAgentEvent({
          ...run,
          sessionKey: params.sessionKey,
          stream: "notice",
          data: { phase: "warning", message: error.message },
        });
      }
    }
    const runtime = createCombinedSessionMcpRuntime({ ...params, parts: [] });
    const catalog: McpToolCatalog = {
      version: 1,
      generatedAt: 0,
      servers: {},
      tools: [],
      ...rememberedCatalog,
      diagnostics: [
        ...(rememberedCatalog?.diagnostics ?? []),
        {
          serverName: "Gateway",
          safeServerName: "gateway",
          launchSummary: "MCP runtime capacity",
          message: error.message,
        },
      ],
    };
    runtime.getCatalog = async () => catalog;
    runtime.peekCatalog = () => catalog;
    runtime.callTool = async () => ({
      isError: true,
      content: [{ type: "text", text: error.message }],
    });
    const unavailable = async () => {
      throw new Error(error.message);
    };
    runtime.listTools = unavailable;
    runtime.listResources = unavailable;
    runtime.readResource = unavailable;
    runtime.listResourceTemplates = unavailable;
    runtime.listPrompts = unavailable;
    runtime.getPrompt = unavailable;
    return runtime;
  };
  const withoutMcp = (params: RuntimeAcquisitionParams, error: SessionMcpRuntimeCapacityError) =>
    leaseRuntime(createUnavailableRuntime(params, error), params.sessionId);
  const prepareAcquisition = (
    params: PreparedAcquisitionParams,
    configReloadAtAdmission: SessionMcpConfigPublication | undefined,
    scope: "full" | "requester",
  ) => {
    const fullConfig = loadSessionMcpConfig({ ...params, logDiagnostics: false });
    const partition = partitionMcpServersByConnectionScope(fullConfig.loaded.mcpServers);
    // Full-set names stay stable when only some requester connections resolve.
    const { safeServerNamesByServer } = fullConfig;
    const requester = params.requester;
    const advertisedCatalogConfigFingerprint = JSON.stringify([
      params.sessionKey,
      params.agentId ?? parseAgentSessionKey(params.sessionKey ?? "")?.agentId,
      params.workspaceDir,
      params.agentDir,
      partition.requesterScopedServerNames.length === 0
        ? fullConfig.fingerprint
        : loadSessionMcpConfig({
            ...params,
            loaded: fullConfig.loaded,
            logDiagnostics: false,
            redactConnectionServerNames: new Set(partition.requesterScopedServerNames),
            safeServerNamesByServer,
          }).fingerprint,
    ]);
    // Static admissions can be projections; requester discovery owns this binding.
    if (scope === "requester" || (requester && partition.requesterScopedServerNames.length > 0)) {
      catalogs.reconcileAdvertisedScopedCatalogConfig(
        {
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId ?? parseAgentSessionKey(params.sessionKey ?? "")?.agentId,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          configFingerprint: advertisedCatalogConfigFingerprint,
        },
        requester !== undefined && partition.requesterScopedServerNames.length > 0,
      );
    }
    return {
      advertisedCatalogConfigFingerprint,
      fullConfig,
      ...partition,
      safeServerNamesByServer,
      requester,
      acquireRequester: () =>
        requester
          ? materializeRequesterScopedRuntime({
              ...params,
              configReloadAtAdmission,
              mcpServers: fullConfig.loaded.mcpServers,
              oauthRequesterServerNames: partition.oauthRequesterServerNames,
              resolverRequesterServerNames: partition.resolverRequesterServerNames,
              scopedNameSet: new Set(partition.requesterScopedServerNames),
              safeServerNamesByServer,
              requesterSenderId: requester.senderId,
              runtimeKey: requester.runtimeKey,
            })
          : undefined,
    };
  };
  const materializeRequesterScopedRuntime = async (
    params: RuntimeAcquisitionParams & {
      configReloadAtAdmission?: SessionMcpConfigPublication;
      mcpServers: Record<string, BundleMcpServerConfig>;
      oauthRequesterServerNames: readonly string[];
      resolverRequesterServerNames: readonly string[];
      scopedNameSet: ReadonlySet<string>;
      safeServerNamesByServer: ReadonlyMap<string, string>;
      requesterSenderId: string;
      runtimeKey: string;
    },
  ) => {
    const oauthRequesterNameSet = new Set(params.oauthRequesterServerNames);
    const resolverRequesterNameSet = new Set(params.resolverRequesterServerNames);
    const agentAccountId = normalizeOptionalString(params.agentAccountId);
    const messageChannel = normalizeOptionalString(params.messageChannel);
    const fullScopedFingerprint = loadSessionMcpConfig({
      ...params,
      logDiagnostics: false,
      includeServerNames: params.scopedNameSet,
      redactConnectionServerNames: resolverRequesterNameSet,
    }).fingerprint;
    const requesterScope = {
      requesterSenderId: params.requesterSenderId,
      ...(agentAccountId ? { agentAccountId } : {}),
      ...(messageChannel ? { messageChannel } : {}),
    };
    const runtime = await install.resolveAndInstallRequesterRuntime({
      ...params,
      fullScopedFingerprint,
      oauthRequesterNameSet,
      agentAccountId,
      messageChannel,
      requesterScope,
      onCapacityRefusal(error, requesterConnect) {
        return Object.assign(createUnavailableRuntime(params, error, params.runtimeKey), {
          requesterScope,
          // This facade has no revocation owner; retain sign-in schemas, never callbacks.
          requesterConnect: requesterConnect && {
            ...requesterConnect,
            createExecute: () => undefined,
          },
        });
      },
    });
    return runtime ? leaseRuntime(runtime, params.runtimeKey) : undefined;
  };

  const manager: SessionMcpRuntimeManager = {
    acquire: acquireCurrent("full", async (params) => {
      const configReloadAtAdmission = store.configReload;
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }

      const {
        fullConfig,
        staticServers,
        requesterScopedServerNames,
        safeServerNamesByServer,
        requester,
        acquireRequester,
      } = prepareAcquisition(params, configReloadAtAdmission, "full");

      const leases: SessionMcpRuntimeLease[] = [];
      try {
        let staticLease: SessionMcpRuntimeLease;
        try {
          const runtimeParams = {
            ...params,
            runtimeKey: params.sessionId,
            configReloadAtAdmission,
            excludeServerNames: new Set(requesterScopedServerNames),
            safeServerNamesByServer,
          };
          staticLease = leaseRuntime(
            await install.getOrCreateRuntimeEntry(
              runtimeParams,
              requesterScopedServerNames.length === 0
                ? fullConfig
                : loadSessionMcpConfig({
                    ...runtimeParams,
                    loaded: fullConfig.loaded,
                    logDiagnostics: false,
                  }),
            ),
            params.sessionId,
          );
        } catch (error) {
          if (!(error instanceof SessionMcpRuntimeCapacityError)) {
            throw error;
          }
          staticLease = withoutMcp(params, error);
        }
        leases.push(staticLease);
        if (requesterScopedServerNames.length === 0) {
          return staticLease;
        }
        const parts = Object.keys(staticServers).length > 0 ? [staticLease.runtime] : [];
        const requesterLease = requester ? await acquireRequester() : undefined;
        if (requesterLease) {
          leases.push(requesterLease);
          parts.push(requesterLease.runtime);
        }
        return {
          runtime:
            parts.length === 0
              ? staticLease.runtime
              : createCombinedSessionMcpRuntime({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  workspaceDir: params.workspaceDir,
                  agentDir: params.agentDir,
                  parts,
                }),
          releaseLease: () => leases.forEach((lease) => lease.releaseLease()),
          async retireUnusedServers(retainedServerNames) {
            const outcomes = await Promise.allSettled(
              leases.map(async (lease) => await lease.retireUnusedServers?.(retainedServerNames)),
            );
            const failed = outcomes.find((outcome) => outcome.status === "rejected");
            if (failed) {
              throw failed.reason;
            }
          },
        };
      } catch (error) {
        leases.forEach((lease) => lease.releaseLease());
        throw error;
      }
    }),
    acquireRequesterScoped: acquireCurrent("requester", async (params) => {
      const configReloadAtAdmission = store.configReload;
      // Anonymous turns own no requester runtime; reconcile first so a cached
      // catalog cannot survive a senderless harness turn.
      const {
        advertisedCatalogConfigFingerprint,
        requesterScopedServerNames,
        requester,
        acquireRequester,
      } = prepareAcquisition(params, configReloadAtAdmission, "requester");
      if (!requester) {
        return undefined;
      }
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const lease = await acquireRequester();
      if (!lease) {
        return undefined;
      }
      return { ...lease, advertisedCatalogConfigFingerprint };
    }),
    rememberAdvertisedScopedCatalog: catalogs.rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog: catalogs.getAdvertisedScopedCatalog,
    resolveSessionId(sessionKey) {
      return store.sessionIdBySessionKey.get(sessionKey);
    },
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? store.sessionIdBySessionKey.get(params.sessionKey) : undefined);
      return sessionId ? store.runtimesBySessionId.get(sessionId) : undefined;
    },
    captureSessionRetirement(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? store.sessionIdBySessionKey.get(params.sessionKey) : undefined);
      if (!sessionId) {
        return undefined;
      }
      const expectedRuntimes = new Map<string, SessionMcpRuntime>();
      const catalogsAreCurrent = catalogs.captureSession(sessionId);
      for (const key of lifecycle.runtimeKeysForSessionId(sessionId)) {
        const runtime = store.runtimesBySessionId.get(key);
        if (runtime) {
          expectedRuntimes.set(key, runtime);
        }
      }
      if (expectedRuntimes.size === 0 && !catalogsAreCurrent) {
        return undefined;
      }
      return {
        sessionId,
        retire: (assertCurrent: () => void) =>
          lifecycle.disposeManagedRuntimes(sessionId, {
            expectedRuntimes,
            catalogsAreCurrent,
            assertCurrent,
            preserveActiveLeases: true,
            preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
          }),
      };
    },
    disposeSession: lifecycle.disposeManagedRuntimes,
    deferRetirement(sessionId, retirementOpts) {
      if (retirementOpts?.retainAcrossReuse === true) {
        for (const runtimeKey of lifecycle.runtimeKeysForSessionId(sessionId)) {
          const runtime = store.runtimesBySessionId.get(runtimeKey);
          if (runtime) {
            revokeMcpAppModelContext(runtime);
          }
        }
        store.requiredRetirementSessionIds.add(sessionId);
      }
      if (
        lifecycle.runtimeKeysForSessionId(sessionId).length === 0 &&
        !catalogs.hasSession(sessionId) &&
        !store.requiredRetirementSessionIds.has(sessionId)
      ) {
        return false;
      }
      store.deferredRetirementSessionIds.add(sessionId);
      return true;
    },
    async completeDeferredRetirement(sessionId, runtime) {
      if (runtime !== undefined && runtime.sessionId !== sessionId) {
        return false;
      }
      const deferred = store.deferredRetirementSessionIds.has(sessionId);
      // A late acquisition can settle after its last idle-sweep owner stopped.
      const unmaintained = !deferred && store.scheduler.signal.aborted;
      if (!deferred && !unmaintained) {
        for (const runtimeKey of lifecycle.runtimeKeysForSessionId(sessionId)) {
          const current = store.runtimesBySessionId.get(runtimeKey);
          if (current && sessionMcpRuntimeOwners.get(current)?.hasServers() === false) {
            await lifecycle.releaseEmptyRuntimeSlot(runtimeKey, current);
          }
        }
        return false;
      }
      if (
        lifecycle.totalActiveLeasesForSessionId(sessionId) > 0 ||
        (runtime?.activeLeases ?? 0) > 0
      ) {
        return false;
      }
      const runtimeKeys = lifecycle.runtimeKeysForSessionId(sessionId);
      if (runtimeKeys.length === 0 && !catalogs.hasSession(sessionId)) {
        return false;
      }
      const pendingWork = runtimeKeys
        .map((runtimeKey) => store.runtimeWorkChains.get(runtimeKey))
        .filter((work) => work !== undefined);
      if (pendingWork.length > 0) {
        // Acquisition can clear ordinary intent or take a replacement lease.
        // Recheck after success or failure; neither may strand required retirement.
        await Promise.allSettled(pendingWork);
        return await manager.completeDeferredRetirement(sessionId, runtime);
      }
      // Retirement belongs to the session. Reuse clears ordinary intent; required
      // intent survives replacement and completes when its last transferred lease releases.
      await lifecycle.disposeManagedRuntimes(sessionId, {
        preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
        requireStoppedScheduler: unmaintained,
      });
      return !unmaintained || lifecycle.runtimeKeysForSessionId(sessionId).length === 0;
    },
    async reloadConfig(reload) {
      resetMcpStartupBackoff();
      store.configReload = {
        ...reload,
        pluginGeneration:
          (store.configReload?.pluginGeneration ?? 0) + (reload.reloadPlugins ? 1 : 0),
      };
      catalogs.clear();
      lifecycle.pruneSessionBookkeeping();
      for (const runtime of store.runtimesBySessionId.values()) {
        const slot = store.runtimeSlots.get(runtime);
        if (slot) {
          slot.idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(reload.cfg);
        }
      }
      lifecycle.ensureIdleSweepTimer();
      // In-flight creation checks this publication before it can expose its runtime.
      await Promise.all(
        [...store.runtimesBySessionId].map(async ([runtimeKey, runtime]) => {
          const owner = sessionMcpRuntimeOwners.get(runtime);
          await owner?.reload(reload);
          if (owner?.hasServers() === false) {
            await lifecycle.releaseEmptyRuntimeSlot(runtimeKey, runtime);
          }
        }),
      );
    },
    disposeAll: () => {
      resetMcpStartupBackoff();
      return lifecycle.disposeManagedRuntimes();
    },
    sweepIdleRuntimes: lifecycle.sweepIdleRuntimes,
    listSessionIds() {
      return [
        ...new Set(Array.from(store.runtimesBySessionId.values(), (runtime) => runtime.sessionId)),
      ].toSorted((a, b) => a.localeCompare(b));
    },
    listRuntimeKeys() {
      return Array.from(store.runtimesBySessionId.keys()).toSorted((a, b) => a.localeCompare(b));
    },
    totalActiveLeasesForSession: lifecycle.totalActiveLeasesForSessionId,
  };
  return Object.assign(manager, {
    setScheduler: lifecycle.setScheduler,
    listSessionIdsForAgent(agentId: string) {
      return [
        ...new Set([
          ...[...store.sessionIdBySessionKey].flatMap(([key, sessionId]) =>
            parseAgentSessionKey(key)?.agentId === agentId &&
            !lifecycle.runtimeKeysForSessionId(sessionId).some((runtimeKey) => {
              const runtime = store.runtimesBySessionId.get(runtimeKey);
              const currentAgent = runtime && sessionMcpRuntimeOwners.get(runtime)?.agentId;
              return currentAgent !== undefined && currentAgent !== agentId;
            })
              ? [sessionId]
              : [],
          ),
          ...[...store.runtimesBySessionId.values()].flatMap((runtime) =>
            sessionMcpRuntimeOwners.get(runtime)?.agentId === agentId ? [runtime.sessionId] : [],
          ),
          ...[...store.pendingDisposals.values()].flatMap((receipt) =>
            receipt.agentId === agentId ? [receipt.sessionId] : [],
          ),
          ...[
            ...store.catalogByRuntimeKey.values(),
            ...store.advertisedScopedCatalogBySessionId.values(),
          ].flatMap((entry) => (entry.agentId === agentId ? [entry.sessionId] : [])),
        ]),
      ];
    },
    retireSessionForAgentDeletion(sessionId: string, agentId: string, assertCurrent: () => void) {
      return lifecycle.disposeManagedRuntimes(sessionId, {
        agentDeletion: {
          agentId,
          assertCurrent,
          deferRetirement: () => manager.deferRetirement(sessionId, { retainAcrossReuse: true }),
        },
      });
    },
  });
}
