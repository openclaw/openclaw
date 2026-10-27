import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type {
  CodexAppServerRequestResult,
  CodexThreadListParams,
  CodexThreadListResponse,
} from "./app-server/protocol.js";
import {
  getSharedCodexAppServerClientState,
  hasActiveSharedCodexAppServerWork,
} from "./app-server/shared-client-lifecycle.js";
import { findCodexAppServerSpawnError } from "./app-server/spawn-error.js";
import { withAbortableTimeout } from "./app-server/timeout.js";
import {
  createCodexCatalogRequestSnapshot,
  createCodexSessionCatalogControlFromRequests,
  type CodexSessionCatalogRequestSnapshot,
} from "./session-catalog-control-requests.js";
import {
  startCodexCatalogPageDiagnostics,
  startCodexCatalogControlRequestDiagnostics,
  type CodexCatalogPageDiagnostics,
} from "./session-catalog-diagnostics.js";
import { codexCatalogResidentHomeKey } from "./session-catalog-events.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  currentCodexCatalogListRequest,
  type CodexCatalogListRequest,
} from "./session-catalog-list-request.js";
import type { CodexCatalogPreviewCache } from "./session-catalog-native-projection.js";
import {
  CodexCatalogNativeWalks,
  type CodexCatalogNativeWalk,
} from "./session-catalog-native-walk.js";
import { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

type CodexCatalogRequestOptions = {
  agentDir: string | undefined;
  config: OpenClawConfig | undefined;
  startOptions: CodexAppServerStartOptions;
};

type CodexCatalogControlSource = Pick<
  CodexCatalogHome,
  "appServer" | "localSessionsRoot" | "sourceHomeId" | "assertCurrent"
> & { agentDir?: string };

/** Builds the passive catalog over the Codex plugin's canonical shared client. */
export function createCodexSessionCatalogControl(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  resolveRuntimeOptions: typeof resolveCodexSupervisionAppServerRuntimeOptions;
  now?: () => number;
  managedThreads?: CodexManagedThreadStore;
  openResidentState?: (homeId: string) => CodexCatalogState;
}): CodexSessionCatalogControlFactory & { start(): Promise<void>; stop(): Promise<void> } {
  const now = params.now ?? Date.now;
  const sourceBackoff = new CodexCatalogSourceBackoff(now);
  const noConfig: OpenClawConfig = {};
  const resolveRuntimeOptions: typeof params.resolveRuntimeOptions = (options) => {
    const runtime = params.resolveRuntimeOptions(options);
    return runtime.start.transport === "stdio" && runtime.start.commandSource === "managed"
      ? { ...runtime, start: { ...runtime.start, managedCommandOrder: "package-only" } }
      : runtime;
  };
  const homeResolver = createCodexCatalogHomeResolver({
    config: params.config ?? {},
    getRuntimeConfig: params.getRuntimeConfig,
    getPluginConfig: params.getPluginConfig,
    resolveRuntimeOptions,
    ...(params.env ? { env: params.env } : {}),
  });
  const requestOptionsByConfig = new WeakMap<
    OpenClawConfig,
    Map<string, CodexCatalogRequestOptions>
  >();
  const indexes = new Map<string, CodexCatalogIndex>();
  const retiringState = new Map<string, Promise<void>>();
  const directHomes = new Map<string, Promise<string>>();
  const residentRequests = new Set<Promise<CodexCatalogIndex>>();
  const nativeWalks = new CodexCatalogNativeWalks();
  let generation = params.getRuntimeConfig();
  let residentEpoch = 0;
  let starting = 0;
  let closed = false;
  let runBackground = (run: () => Promise<void>) => run();
  let retiring: Promise<void> | undefined;
  const retireIndexes = (): Promise<void> => {
    residentEpoch++;
    const nativeDrain = nativeWalks.retire();
    const closing: Promise<void>[] = [];
    for (const [homeId, index] of indexes) {
      const writes = index.retire().finally(() => {
        if (retiringState.get(homeId) === writes) {
          retiringState.delete(homeId);
        }
      });
      retiringState.set(homeId, writes);
      closing.push(writes, index.close());
    }
    indexes.clear();
    directHomes.clear();
    const drain = Promise.allSettled([nativeDrain, retiring, ...closing]).then((results) => {
      if (retiring === drain) {
        retiring = undefined;
      }
      if (results[0]?.status === "rejected") {
        throw results[0].reason;
      }
    });
    retiring = drain;
    void drain.catch(() => {});
    return drain;
  };
  const resolveResident = async (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): Promise<CodexCatalogIndex> => {
    if (closed) {
      throw new Error("Codex resident catalog is closed");
    }
    const config = params.getRuntimeConfig();
    if (generation !== config) {
      generation = config;
      void retireIndexes();
    }
    const epoch = residentEpoch;
    const runtime =
      source?.appServer ?? resolveRuntimeOptions({ pluginConfig: params.getPluginConfig() });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    const key = source?.sourceHomeId ?? agentId ?? "";
    let home = directHomes.get(key);
    if (!home) {
      home = codexCatalogResidentHomeKey({
        startOptions: requestOptions.startOptions,
        agentDir: requestOptions.agentDir,
        sourceHomeId: source?.sourceHomeId,
      });
      directHomes.set(key, home);
    }
    const homeId = await home;
    // Only already-admitted writes can affect the replacement's snapshot.
    // Retired native reads remain owned by stop(), without delaying this list.
    await retiringState.get(homeId);
    if (closed || generation !== config || residentEpoch !== epoch) {
      throw new Error("Codex catalog configuration changed");
    }
    let index = indexes.get(homeId);
    if (!index) {
      const [
        { CodexCatalogIndex },
        { canReuseCodexCatalogPreview, projectCodexCatalogDeltaPage, projectCodexCatalogPage },
      ] = await Promise.all([
        import("./session-catalog-index.js"),
        import("./session-catalog-projection.js"),
      ]);
      source?.assertCurrent();
      if (closed || generation !== config || residentEpoch !== epoch) {
        throw new Error("Codex catalog configuration changed");
      }
      index = indexes.get(homeId);
      if (index) {
        return index;
      }
      const root =
        source?.localSessionsRoot ??
        (runtime.connectionClass !== "remote"
          ? path.join(
              resolveCodexAppServerLocalHomeDir(
                requestOptions.startOptions,
                requestOptions.agentDir,
                params.env,
              ),
              "sessions",
            )
          : undefined);
      let nativeAttempt: ReturnType<CodexCatalogSourceBackoff["begin"]> | undefined;
      let nativeWalk: CodexCatalogNativeWalk | undefined;
      const readNativePage = async <T>(
        query: CodexThreadListParams,
        remainingRows: number,
        project: (
          response: CodexThreadListResponse,
          diagnostics: CodexCatalogPageDiagnostics | undefined,
        ) => T | Promise<T>,
        foreground?: CodexCatalogListRequest,
      ): Promise<T> => {
        const requests = createRequestSnapshot(
          agentId,
          source,
          true,
          query.useStateDbOnly
            ? (thread) => {
                const row = index?.get(thread.id);
                return canReuseCodexCatalogPreview(row, thread) ? row?.preview : undefined;
              }
            : undefined,
          remainingRows,
          foreground ? undefined : nativeWalk,
        );
        const attempt = foreground
          ? requests.beginList(foreground)
          : query.cursor && nativeAttempt
            ? nativeAttempt
            : requests.beginList();
        if (!foreground) {
          nativeAttempt = attempt;
        }
        if (!attempt.allowed) {
          throw attempt.error;
        }
        const diagnostics = startCodexCatalogPageDiagnostics("cold");
        if (diagnostics) {
          diagnostics.fields.controlRequestCalls = 1;
        }
        const observation = startCodexCatalogControlRequestDiagnostics(diagnostics);
        let outcome: "resolved" | "rejected" = "rejected";
        try {
          const started = performance.now();
          let response: CodexThreadListResponse;
          try {
            response = await requests.listThreads(
              query,
              foreground?.remaining(requests.requestTimeoutMs) ?? requests.requestTimeoutMs,
              observation,
            );
          } finally {
            if (diagnostics) {
              const elapsed = performance.now() - started;
              diagnostics.fields.inclusiveControlRequestWaitMs = elapsed;
              diagnostics.fields.inclusiveControlRequestWaitMaxMs = elapsed;
            }
          }
          foreground?.assertActive();
          const page = await project(response, diagnostics);
          foreground?.assertActive();
          outcome = "resolved";
          return page;
        } catch (error) {
          observation?.rejected();
          throw error;
        } finally {
          observation?.close();
          diagnostics?.finish(outcome);
        }
      };
      index = new CodexCatalogIndex({
        homeId,
        requestTimeoutMs: runtime.requestTimeoutMs,
        runBackground: (run) => runBackground(run),
        localSessionsRoot: root,
        state: params.openResidentState?.(homeId),
        runNativeWalk: async (run) => {
          try {
            // Socket servers and Windows retain their existing shared-client
            // contract; their transport close cannot certify POSIX process containment.
            const result =
              runtime.start.transport !== "stdio" || process.platform === "win32"
                ? await run()
                : await nativeWalks.run(
                    {
                      ...requestOptions,
                      authProfileId: null,
                      timeoutMs: runtime.requestTimeoutMs,
                      assertCurrent: () => {
                        source?.assertCurrent();
                        if (
                          closed ||
                          params.getRuntimeConfig() !== config ||
                          residentEpoch !== epoch
                        ) {
                          throw new Error("Codex catalog configuration changed");
                        }
                      },
                    },
                    async (walk) => {
                      nativeWalk = walk;
                      try {
                        return await run();
                      } finally {
                        nativeWalk = undefined;
                      }
                    },
                  );
            if (nativeAttempt?.allowed) {
              nativeAttempt.resolved();
            }
            return result;
          } catch (error) {
            if (nativeAttempt?.allowed) {
              nativeAttempt.rejected(error);
            }
            throw error;
          } finally {
            nativeAttempt = undefined;
          }
        },
        assertCurrent: () => {
          source?.assertCurrent();
          if (closed || params.getRuntimeConfig() !== config || residentEpoch !== epoch) {
            throw new Error("Codex catalog configuration changed");
          }
        },
        readNative: (query, remainingRows, foreground) =>
          readNativePage(
            query,
            Math.min(64, remainingRows),
            async (response, diagnostics) => {
              const { sanitizeTerminalText } = await import("openclaw/plugin-sdk/text-chunking");
              const bounded = { ...response, data: response.data.slice(0, remainingRows) };
              const projection = {
                localSessionsRoot: root,
                sanitize: sanitizeTerminalText,
                diagnostics,
              };
              return query.useStateDbOnly
                ? await projectCodexCatalogDeltaPage(bounded, {
                    ...projection,
                    getRow: (threadId) => index?.get(threadId),
                  })
                : await projectCodexCatalogPage(bounded, projection);
            },
            foreground,
          ),
      });
      indexes.set(homeId, index);
    }
    return index;
  };
  const residentFor = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): Promise<CodexCatalogIndex> => {
    const request = resolveResident(agentId, source);
    residentRequests.add(request);
    const release = () => residentRequests.delete(request);
    void request.then(release, release);
    return request;
  };
  const resolveRequestOptions = (
    startOptions: CodexAppServerStartOptions,
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): CodexCatalogRequestOptions => {
    source?.assertCurrent();
    const runtimeConfig = params.getRuntimeConfig();
    const agentDir =
      source?.agentDir ?? (agentId ? resolveAgentDir(runtimeConfig ?? {}, agentId) : undefined);
    const resolvedStartOptions = source?.appServer.start ?? startOptions;
    if (!runtimeConfig) {
      return {
        agentDir,
        config: undefined,
        startOptions: structuredClone(resolvedStartOptions),
      };
    }
    let byAgent = requestOptionsByConfig.get(runtimeConfig);
    const cacheKey = `${agentId ?? ""}\0${source?.sourceHomeId ?? ""}`;
    const cached = byAgent?.get(cacheKey);
    if (cached) {
      // Plugin start options derive from this same immutable config snapshot. Config reload changes
      // object identity; re-cloning on every poll only adds CPU and allocation to the catalog path.
      return cached;
    }
    const resolved = {
      agentDir,
      config: structuredClone(runtimeConfig),
      startOptions: structuredClone(resolvedStartOptions),
    };
    if (!byAgent) {
      byAgent = new Map();
      requestOptionsByConfig.set(runtimeConfig, byAgent);
    }
    byAgent.set(cacheKey, resolved);
    return resolved;
  };
  const createRequestSnapshot = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
    catalogPreview?: true,
    catalogPreviewCache?: CodexCatalogPreviewCache,
    catalogRows?: number,
    nativeWalk?: CodexCatalogNativeWalk,
  ): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = params.getPluginConfig();
    const runtime = source?.appServer ?? resolveRuntimeOptions({ pluginConfig });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    return createCodexCatalogRequestSnapshot(
      runtime.requestTimeoutMs,
      async (method, requestParams, timeoutMs, assertCurrent, observation) => {
        if (nativeWalk) {
          try {
            observation?.phase("acquire-client");
          } catch {
            // Diagnostic callbacks cannot change native walk behavior.
          }
          const walk = nativeWalk;
          const pageBudget = timeoutMs ?? runtime.requestTimeoutMs;
          const started = performance.now();
          const message = `codex app-server ${method} timed out`;
          const operation = (async () => {
            const client = await walk.client(pageBudget);
            const { requestCodexAppServerClientJson } = await import("./app-server/request.js");
            walk.signal.throwIfAborted();
            const remaining =
              pageBudget > 0 ? pageBudget - (performance.now() - started) : pageBudget;
            if (pageBudget > 0 && remaining <= 0) {
              throw new Error(message);
            }
            return await requestCodexAppServerClientJson<
              CodexAppServerRequestResult<typeof method>
            >({
              client,
              method,
              requestParams,
              timeoutMs: remaining,
              signal: walk.signal,
              assertCurrent: () => {
                walk.signal.throwIfAborted();
                source?.assertCurrent();
                assertCurrent?.();
              },
              config: requestOptions.config,
              ...(catalogPreview && method === CODEX_CONTROL_METHODS.listThreads
                ? { catalogPreview, catalogRows, catalogPreviewCache }
                : {}),
              ...(observation ? { controlObservation: observation } : {}),
            });
          })();
          try {
            return await withAbortableTimeout({
              promise: operation,
              signal: walk.signal,
              timeoutMs: pageBudget,
              timeoutMessage: message,
            });
          } catch (error) {
            walk.abort(error);
            throw error;
          }
        }
        const { codexControlRequest } = await import("./command-rpc.js");
        return await codexControlRequest(pluginConfig, method, requestParams, {
          ...requestOptions,
          authProfileId: null,
          assertCurrent,
          ...(catalogPreview && method === CODEX_CONTROL_METHODS.listThreads
            ? {
                catalogPreview,
                catalogRows,
                ...(catalogPreviewCache ? { catalogPreviewCache } : {}),
              }
            : {}),
          ...(observation ? { controlObservation: observation } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
      () => residentFor(agentId, source),
      (request) =>
        sourceBackoff.begin(
          requestOptions.config ?? noConfig,
          agentId,
          source?.sourceHomeId,
          request,
        ),
      catalogPreview === true,
    );
  };

  const forRequest = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
  ): CodexSessionCatalogControl => {
    source?.assertCurrent();
    const withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"] = async (
      run,
    ) => {
      const pluginConfig = params.getPluginConfig();
      const runtime = source?.appServer ?? resolveRuntimeOptions({ pluginConfig });
      const {
        agentDir,
        config: runtimeConfig,
        startOptions,
      } = resolveRequestOptions(runtime.start, agentId, source);
      let catalogIndex: Promise<CodexCatalogIndex> | undefined;
      // Capture the request's config/home before loading execution; imports must
      // not let a concurrent reload move this pinned operation to another owner.
      const {
        getLeasedSharedCodexAppServerClient,
        releaseLeasedSharedCodexAppServerClient,
        retireSharedCodexAppServerClientIfCurrent,
      } = await import("./app-server/shared-client.js");
      const { resolveCodexAppServerClientInstanceId } = await import("./app-server/client.js");
      const { requestCodexAppServerClientJson } = await import("./app-server/request.js");
      const client = await getLeasedSharedCodexAppServerClient({
        agentDir,
        config: runtimeConfig,
        startOptions,
        authProfileId: null,
        timeoutMs:
          currentCodexCatalogListRequest()?.remaining(runtime.requestTimeoutMs) ??
          runtime.requestTimeoutMs,
      });
      try {
        const requests = createCodexCatalogRequestSnapshot(
          runtime.requestTimeoutMs,
          async (method, requestParams, timeoutMs, assertCurrent, observation) =>
            await requestCodexAppServerClientJson<CodexAppServerRequestResult<typeof method>>({
              client,
              method,
              requestParams,
              config: runtimeConfig,
              timeoutMs: timeoutMs ?? runtime.requestTimeoutMs,
              assertCurrent,
              ...(observation ? { controlObservation: observation } : {}),
            }),
          () => (catalogIndex ??= residentFor(agentId, source)),
          (request) =>
            sourceBackoff.begin(runtimeConfig ?? noConfig, agentId, source?.sourceHomeId, request),
        );
        const pinnedControl: CodexSessionCatalogControl =
          createCodexSessionCatalogControlFromRequests({
            forkContext: agentDir
              ? {
                  client,
                  appServer: runtime,
                  pluginConfig,
                  agentDir,
                  localSessionsRoot: source?.localSessionsRoot,
                }
              : undefined,
            clientId: resolveCodexAppServerClientInstanceId(client),
            retireConnection: () => {
              retireSharedCodexAppServerClientIfCurrent(client);
            },
            connectionFingerprint: buildCodexAppServerConnectionFingerprint(runtime, agentDir),
            createRequestSnapshot: () => requests,
            ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
            sourceHomeId: source?.sourceHomeId,
            managedThreads: params.managedThreads,
            now,
            withPinnedConnection: async (nestedRun) => await nestedRun(pinnedControl),
          });
        return await run(pinnedControl);
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    };
    const control = createCodexSessionCatalogControlFromRequests({
      createRequestSnapshot: () => createRequestSnapshot(agentId, source),
      ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
      now,
      withPinnedConnection,
    });
    return {
      ...control,
      requireEligibleThread: (threadId) =>
        withPinnedConnection((pinned) => pinned.requireEligibleThread(threadId)),
      async listPage(pageParams: CodexSessionCatalogPageParams) {
        source?.assertCurrent();
        return await control.listPage(pageParams);
      },
    };
  };
  const forUpstream = async (agentId: string, connectionFingerprint: string) => {
    // A fingerprint is correlation only. A miss must stay fail-closed instead of selecting a
    // different home whose thread namespace could contain the same copied identifier.
    const source = (await homeResolver.forAgent(agentId)).find(
      (home) =>
        buildCodexAppServerConnectionFingerprint(home.appServer, home.agentDir) ===
        connectionFingerprint,
    );
    return source ? forRequest(agentId, source) : undefined;
  };
  return {
    hasActiveWork: () =>
      starting > 0 ||
      residentRequests.size > 0 ||
      retiring !== undefined ||
      hasActiveSharedCodexAppServerWork() ||
      [...indexes.values()].some((index) => index.hasActiveWork()),
    async disconnect() {
      let failure: { error: unknown } | undefined;
      try {
        await retireIndexes();
      } catch (error) {
        failure = { error };
      }
      await Promise.allSettled(residentRequests);
      // Node disconnect owns these transports; Gateway service retirement does not.
      try {
        const clients = getSharedCodexAppServerClientState();
        if (clients.liveClients.size > 0 || clients.startup.pending.size > 0) {
          const { clearSharedCodexAppServerClientAndWait } =
            await import("./app-server/shared-client.js");
          await clearSharedCodexAppServerClientAndWait();
        }
      } catch (error) {
        failure ??= { error };
      }
      if (failure) {
        throw failure.error;
      }
    },
    async start() {
      const epoch = residentEpoch;
      starting++;
      try {
        const serviceScope = AsyncLocalStorage.snapshot();
        runBackground = (run) => serviceScope(run);
        for (const agentId of listAgentIds(params.getRuntimeConfig() ?? params.config ?? {})) {
          for (const source of await homeResolver.forAgent(agentId)) {
            if (closed || residentEpoch !== epoch) {
              return;
            }
            // Implicit process HOME is admitted by the Gateway's request policy.
            // Explicit homes can hydrate at activation without bypassing that policy.
            if (source.usesProcessHomeFallback) {
              continue;
            }
            void forRequest(agentId, source)
              .initialize()
              .catch((error: unknown) => {
                if (!findCodexAppServerSpawnError(error)) {
                  embeddedAgentLog.warn("Codex catalog hydration failed", { error });
                }
              });
          }
        }
      } finally {
        starting--;
      }
    },
    async stop() {
      closed = true;
      const settled = await Promise.allSettled([
        retireIndexes(),
        nativeWalks.close(),
        Promise.allSettled(residentRequests),
      ]);
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    },
    forRequest,
    forUpstream,
    homesForAgent: homeResolver.forAgent,
    async forNode(agentId) {
      const source = await homeResolver.forNode(agentId);
      return {
        assertCurrent: () => source.assertCurrent(),
        control: forRequest(source.agentId, source),
        sourceHomeId: source.sourceHomeId,
        codexHome: source.codexHome,
        transport: source.appServer.start.transport,
      };
    },
  };
}
