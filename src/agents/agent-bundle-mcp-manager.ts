/** Session MCP runtime manager: get-or-create and requester-scoped install orchestration. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import {
  createCombinedSessionMcpRuntime,
  isCombinedSessionMcpRuntime,
} from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntimeManagerInstall } from "./agent-bundle-mcp-manager-install.js";
import {
  createSessionMcpRuntimeManagerLifecycle,
  createSessionMcpRuntimeManagerStore,
  type SessionMcpRuntimeManagerOpts,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import {
  resolveSessionMcpRuntimeIdleTtlMs,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import {
  buildMcpRequesterRuntimeCacheKey,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";

/** Bound from agent-bundle-mcp-runtime.ts to avoid an import cycle with the facade. */
let defaultCreateSessionMcpRuntime: CreateSessionMcpRuntime | undefined;

export function setDefaultCreateSessionMcpRuntime(fn: CreateSessionMcpRuntime): void {
  defaultCreateSessionMcpRuntime = fn;
}

function resolveCreateSessionMcpRuntime(
  createRuntime?: CreateSessionMcpRuntime,
): CreateSessionMcpRuntime {
  const resolved = createRuntime ?? defaultCreateSessionMcpRuntime;
  if (!resolved) {
    throw new Error("Session MCP runtime factory is not bound");
  }
  return resolved;
}

/** Qualifies unscoped keys and rejects conflicting scoped owners before runtime lookup. */
function resolveAgentBoundSessionKey(agentId: string, sessionKey: string): string | undefined {
  const normalizedAgentId = normalizeOptionalAgentId(agentId);
  if (!normalizedAgentId) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed && normalizeAgentId(parsed.agentId) !== normalizedAgentId) {
    return undefined;
  }
  if (!parsed && sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  return toAgentStoreSessionKey({ agentId: normalizedAgentId, requestKey: sessionKey });
}

function resolveAgentBoundSessionKeyForCreation(
  agentId: string | undefined,
  sessionKey: string,
): string | undefined {
  const normalizedAgentId = normalizeOptionalAgentId(agentId);
  if (!normalizedAgentId) {
    const parsed = parseAgentSessionKey(sessionKey);
    return parsed ? resolveAgentBoundSessionKey(parsed.agentId, sessionKey) : undefined;
  }
  const bindingKey = resolveAgentBoundSessionKey(normalizedAgentId, sessionKey);
  if (!bindingKey) {
    throw new Error(
      `Session MCP runtime agent "${normalizedAgentId}" does not match session key "${sessionKey}"`,
    );
  }
  return bindingKey;
}

export function createSessionMcpRuntimeManager(
  opts: SessionMcpRuntimeManagerOpts = {},
): SessionMcpRuntimeManager {
  const store = createSessionMcpRuntimeManagerStore(
    opts,
    resolveCreateSessionMcpRuntime(opts.createRuntime),
  );
  const lifecycle = createSessionMcpRuntimeManagerLifecycle(store);
  const install = createSessionMcpRuntimeManagerInstall(lifecycle);
  const rememberSessionKeyOwnerBinding = (params: {
    sessionKey: string;
    ownerKey: string;
    sessionId: string;
  }) => {
    const bindings =
      store.sessionIdsBySessionKeyOwner.get(params.sessionKey) ?? new Map<string, string>();
    bindings.set(params.ownerKey, params.sessionId);
    store.sessionIdsBySessionKeyOwner.set(params.sessionKey, bindings);
  };
  const resolveUniqueSessionId = (sessionKey: string): string | undefined => {
    const bindings = store.sessionIdsBySessionKeyOwner.get(sessionKey);
    if (!bindings) {
      return undefined;
    }
    const sessionIds = new Set(bindings.values());
    return sessionIds.size === 1 ? sessionIds.values().next().value : undefined;
  };
  const rememberSessionBinding = (params: {
    sessionKey: string;
    sessionId: string;
    agentBoundSessionKey?: string;
  }) => {
    const ownerKey = params.agentBoundSessionKey ?? `session-id:${params.sessionId}`;
    rememberSessionKeyOwnerBinding({
      sessionKey: params.sessionKey,
      ownerKey,
      sessionId: params.sessionId,
    });
    if (params.agentBoundSessionKey && params.agentBoundSessionKey !== params.sessionKey) {
      rememberSessionKeyOwnerBinding({
        sessionKey: params.agentBoundSessionKey,
        ownerKey,
        sessionId: params.sessionId,
      });
    }
  };
  const rememberSuccessfulSessionBinding = (params: {
    sessionId: string;
    sessionKey?: string;
    agentBoundSessionKey?: string;
    runtime: SessionMcpRuntime;
  }): SessionMcpRuntime => {
    if (!params.sessionKey) {
      return params.runtime;
    }
    // Disposal can race a completed create/reuse. Commit synchronously only
    // while this session still owns a managed runtime, or stale keys resurrect.
    if (lifecycle.runtimeKeysForSessionId(params.sessionId).length === 0) {
      return params.runtime;
    }
    rememberSessionBinding({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      ...(params.agentBoundSessionKey ? { agentBoundSessionKey: params.agentBoundSessionKey } : {}),
    });
    return params.runtime;
  };

  const manager: SessionMcpRuntimeManager = {
    async getOrCreate(params) {
      const agentBoundSessionKey = params.sessionKey
        ? resolveAgentBoundSessionKeyForCreation(params.agentId, params.sessionKey)
        : undefined;
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      await lifecycle.sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        lifecycle.ensureIdleSweepTimer();
      }

      const fullConfig = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
      });
      // Safe names from the FULL declared set so partial resolution never changes tool names.
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        fullConfig.loaded.mcpServers,
      );
      const hasRequesterScoped = requesterScopedServerNames.length > 0;

      if (!hasRequesterScoped) {
        const runtime = await install.getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          safeServerNamesByServer,
        });
        return rememberSuccessfulSessionBinding({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentBoundSessionKey,
          runtime,
        });
      }

      const parts: SessionMcpRuntime[] = [];
      const scopedNameSet = new Set(requesterScopedServerNames);
      let emptyStaticRuntime: SessionMcpRuntime | undefined;
      if (Object.keys(staticServers).length > 0) {
        parts.push(
          await install.getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            excludeServerNames: scopedNameSet,
            safeServerNamesByServer,
          }),
        );
      } else {
        // Reconcile bare key when every server is requester-scoped.
        emptyStaticRuntime = await install.getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          includeServerNames: new Set(),
          safeServerNamesByServer,
        });
      }

      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      if (requesterSenderId) {
        const requesterScope: SessionMcpRequesterScope = {
          requesterSenderId,
          ...(normalizeOptionalString(params.agentAccountId)
            ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
            : {}),
          ...(normalizeOptionalString(params.messageChannel)
            ? { messageChannel: normalizeOptionalString(params.messageChannel) }
            : {}),
        };
        const runtimeKey = buildMcpRequesterRuntimeCacheKey({
          sessionId: params.sessionId,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
          requesterSenderId,
        });
        const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          logDiagnostics: false,
          manifestRegistry: params.manifestRegistry,
          includeServerNames: scopedNameSet,
          redactConnectionServerNames: scopedNameSet,
          safeServerNamesByServer,
        });
        const scopedRuntime = await lifecycle.runExclusiveOnRuntimeKey(runtimeKey, () =>
          install.resolveAndInstallRequesterRuntime({
            runtimeKey,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            requesterScopedServerNames,
            scopedNameSet,
            safeServerNamesByServer,
            fullScopedFingerprint,
            requesterSenderId,
            agentAccountId: params.agentAccountId,
            messageChannel: params.messageChannel,
            requesterScope,
          }),
        );
        if (scopedRuntime) {
          parts.push(scopedRuntime);
        }
        await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
      }

      if (parts.length === 0) {
        const runtime =
          emptyStaticRuntime ??
          (await install.getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            includeServerNames: new Set(),
            safeServerNamesByServer,
          }));
        return rememberSuccessfulSessionBinding({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentBoundSessionKey,
          runtime,
        });
      }

      const runtime = createCombinedSessionMcpRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        parts,
      });
      return rememberSuccessfulSessionBinding({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentBoundSessionKey,
        runtime,
      });
    },
    async getOrCreateRequesterScoped(params) {
      // Scoped-only path for shared-thread harnesses: never open static transports
      // (those stay harness-native) so we do not double-connect.
      const agentBoundSessionKey = params.sessionKey
        ? resolveAgentBoundSessionKeyForCreation(params.agentId, params.sessionKey)
        : undefined;
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      await lifecycle.sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        lifecycle.ensureIdleSweepTimer();
      }
      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      if (!requesterSenderId) {
        return undefined;
      }
      const fullConfig = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
      });
      const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        fullConfig.loaded.mcpServers,
      );
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const scopedNameSet = new Set(requesterScopedServerNames);
      const requesterScope: SessionMcpRequesterScope = {
        requesterSenderId,
        ...(normalizeOptionalString(params.agentAccountId)
          ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
          : {}),
        ...(normalizeOptionalString(params.messageChannel)
          ? { messageChannel: normalizeOptionalString(params.messageChannel) }
          : {}),
      };
      const runtimeKey = buildMcpRequesterRuntimeCacheKey({
        sessionId: params.sessionId,
        messageChannel: params.messageChannel,
        agentAccountId: params.agentAccountId,
        requesterSenderId,
      });
      const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: scopedNameSet,
        redactConnectionServerNames: scopedNameSet,
        safeServerNamesByServer,
      });
      const scopedRuntime = await lifecycle.runExclusiveOnRuntimeKey(runtimeKey, () =>
        install.resolveAndInstallRequesterRuntime({
          runtimeKey,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          requesterScopedServerNames,
          scopedNameSet,
          safeServerNamesByServer,
          fullScopedFingerprint,
          requesterSenderId,
          agentAccountId: params.agentAccountId,
          messageChannel: params.messageChannel,
          requesterScope,
        }),
      );
      if (scopedRuntime) {
        await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
        return rememberSuccessfulSessionBinding({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentBoundSessionKey,
          runtime: scopedRuntime,
        });
      }
      return undefined;
    },
    rememberAdvertisedScopedCatalog: lifecycle.rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog: lifecycle.getAdvertisedScopedCatalog,
    bindSessionKey(sessionKey, sessionId) {
      rememberSessionBinding({ sessionKey, sessionId });
    },
    resolveSessionId(sessionKey) {
      return resolveUniqueSessionId(sessionKey);
    },
    resolveAgentSessionId(agentId, sessionKey) {
      const bindingKey = resolveAgentBoundSessionKey(agentId, sessionKey);
      return bindingKey ? resolveUniqueSessionId(bindingKey) : undefined;
    },
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? resolveUniqueSessionId(params.sessionKey) : undefined);
      return sessionId ? store.runtimesBySessionId.get(sessionId) : undefined;
    },
    async disposeSession(sessionId) {
      await lifecycle.disposeManagedSession(sessionId);
    },
    deferRetirement(sessionId, retirementOpts) {
      if (retirementOpts?.retainAcrossReuse === true) {
        store.requiredRetirementSessionIds.add(sessionId);
      } else {
        store.requiredRetirementSessionIds.delete(sessionId);
      }
      if (
        lifecycle.runtimeKeysForSessionId(sessionId).length === 0 &&
        retirementOpts?.retainAcrossReuse !== true
      ) {
        return false;
      }
      store.deferredRetirementSessionIds.add(sessionId);
      return true;
    },
    async completeDeferredRetirement(sessionId, runtime) {
      if (
        !store.deferredRetirementSessionIds.has(sessionId) ||
        (runtime !== undefined && runtime.sessionId !== sessionId)
      ) {
        return false;
      }
      if (
        lifecycle.totalActiveLeasesForSessionId(sessionId) > 0 ||
        (runtime?.activeLeases ?? 0) > 0
      ) {
        return false;
      }
      const managed = lifecycle
        .runtimeKeysForSessionId(sessionId)
        .map((runtimeKey) => store.runtimesBySessionId.get(runtimeKey))
        .filter((entry): entry is SessionMcpRuntime => Boolean(entry));
      if (managed.length === 0) {
        return false;
      }
      const managedSet = new Set(managed);
      if (runtime !== undefined) {
        if (isCombinedSessionMcpRuntime(runtime)) {
          if (!runtime.managedParts.every((part) => managedSet.has(part))) {
            return false;
          }
        } else if (!managedSet.has(runtime)) {
          return false;
        }
      }
      await lifecycle.disposeManagedSession(sessionId, {
        preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
      });
      return true;
    },
    async disposeAll() {
      lifecycle.clearIdleSweepTimer();
      // Drain all requester chains before clearing maps.
      const chains = Array.from(store.requesterWorkChains.values());
      store.requesterWorkChains.clear();
      await Promise.allSettled(chains);
      const inFlightRuntimes = Array.from(store.createInFlight.values());
      store.createInFlight.clear();
      const runtimes = Array.from(store.runtimesBySessionId.values());
      store.runtimesBySessionId.clear();
      store.sessionIdsBySessionKeyOwner.clear();
      store.idleTtlMsBySessionId.clear();
      store.deferredRetirementSessionIds.clear();
      store.requiredRetirementSessionIds.clear();
      store.connectionMetaByRuntimeKey.clear();
      store.advertisedScopedCatalogBySessionId.clear();
      const lateRuntimes = await Promise.all(
        inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionMcpRuntime>(runtimes);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
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
    totalActiveLeasesForSession(sessionId) {
      return lifecycle.totalActiveLeasesForSessionId(sessionId);
    },
  };
  // Test-only bookkeeping snapshot for drain assertions.
  Object.assign(manager, {
    bookkeepingSizesForTest: () => ({
      runtimes: store.runtimesBySessionId.size,
      connectionMeta: store.connectionMetaByRuntimeKey.size,
      createInFlight: store.createInFlight.size,
      requesterWorkChains: store.requesterWorkChains.size,
      sessionKeys: store.sessionIdsBySessionKeyOwner.size,
      idleTtl: store.idleTtlMsBySessionId.size,
      deferredRetirement: store.deferredRetirementSessionIds.size,
      advertisedScopedCatalogs: store.advertisedScopedCatalogBySessionId.size,
    }),
  });
  return manager;
}
