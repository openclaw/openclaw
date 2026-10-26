import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import { readCodexPluginConfig } from "./app-server/config-parsing.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type {
  CodexAppServerRequestResult,
  CodexThreadListResponse,
  CodexAppServerRequestParams,
} from "./app-server/protocol.js";
import { remainingCodexRequestTime } from "./app-server/request-attempt.js";
import type { CodexControlRequestObservation } from "./app-server/request-observation.js";
import { CodexCatalogResponseTooLargeError } from "./app-server/rpc-error.js";
import {
  getSharedCodexAppServerClientState,
  hasActiveSharedCodexAppServerWork,
} from "./app-server/shared-client-lifecycle.js";
import {
  startCodexCatalogPageDiagnostics,
  startCodexCatalogControlRequestDiagnostics,
} from "./session-catalog-diagnostics.js";
import { requireEligibleCodexThread } from "./session-catalog-eligibility.js";
import { codexCatalogResidentHomeKey } from "./session-catalog-events.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import type { CodexCatalogState } from "./session-catalog-index-state.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  currentCodexCatalogListRequest,
  withCodexCatalogListRequest,
} from "./session-catalog-list-request.js";
import type { CodexCatalogPreviewCache } from "./session-catalog-native-projection.js";
import { readControlCursor, readPageParams } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogRequestSnapshot } from "./session-catalog-request-types.js";
import { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";

type CodexCatalogRequestMethod =
  | typeof CODEX_CONTROL_METHODS.archiveThread
  | typeof CODEX_CONTROL_METHODS.forkThread
  | typeof CODEX_CONTROL_METHODS.listThreads
  | typeof CODEX_CONTROL_METHODS.listThreadTurns
  | typeof CODEX_CONTROL_METHODS.listThreadItems
  | typeof CODEX_CONTROL_METHODS.readThread;

type CodexCatalogRequest = <M extends CodexCatalogRequestMethod>(
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  timeoutMs?: number,
  assertCurrent?: () => void,
  observation?: CodexControlRequestObservation,
) => Promise<CodexAppServerRequestResult<M>>;

function createCodexCatalogRequestSnapshot(
  requestTimeoutMs: number,
  request: CodexCatalogRequest,
  index: () => Promise<CodexCatalogIndex>,
  beginList: CodexSessionCatalogRequestSnapshot["beginList"],
  catalogRead = false,
): CodexSessionCatalogRequestSnapshot {
  const read = <M extends CodexCatalogRequestMethod>(
    method: M,
    params: CodexAppServerRequestParams<M>,
    timeoutMs?: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexAppServerRequestResult<M>> => {
    // Index reads are charged by NativePages; hydration never borrows a caller's scope.
    const scope = catalogRead ? undefined : currentCodexCatalogListRequest();
    if (!scope) {
      return request(method, params, timeoutMs, undefined, observation);
    }
    return scope.read(timeoutMs ?? requestTimeoutMs, async (remaining) => {
      const attempt = beginList(scope);
      if (!attempt.allowed) {
        throw attempt.error;
      }
      return await request(method, params, remaining, undefined, observation);
    });
  };
  return {
    index,
    beginList,
    get requestTimeoutMs() {
      return catalogRead
        ? requestTimeoutMs
        : (currentCodexCatalogListRequest()?.remaining(requestTimeoutMs) ?? requestTimeoutMs);
    },
    listThreads: (params, timeoutMs, observation) =>
      read(CODEX_CONTROL_METHODS.listThreads, params, timeoutMs, observation),
    listThreadTurns: (params) => read(CODEX_CONTROL_METHODS.listThreadTurns, params),
    listThreadItems: (params) => read(CODEX_CONTROL_METHODS.listThreadItems, params),
    forkThread: (params, assertCurrent) =>
      request(CODEX_CONTROL_METHODS.forkThread, params, undefined, assertCurrent),
    readThread: async (threadId, includeTurns, timeoutMs) =>
      (await read(CODEX_CONTROL_METHODS.readThread, { threadId, includeTurns }, timeoutMs)).thread,
    archiveThread: async (threadId, assertCurrent) => {
      await request(CODEX_CONTROL_METHODS.archiveThread, { threadId }, undefined, assertCurrent);
    },
  };
}

function createCodexSessionCatalogControlFromRequests(params: {
  forkContext?: CodexSessionCatalogControl["forkContext"];
  clientId?: string;
  retireConnection?: () => void;
  connectionFingerprint?: string;
  createRequestSnapshot: () => CodexSessionCatalogRequestSnapshot;
  localSessionsRoot?: string;
  sourceHomeId?: string;
  managedThreads?: CodexManagedThreadStore;
  now: () => number;
  withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"];
}): CodexSessionCatalogControl {
  return {
    forkContext: params.forkContext,
    ...(params.clientId ? { clientId: params.clientId } : {}),
    ...(params.connectionFingerprint
      ? { connectionFingerprint: params.connectionFingerprint }
      : {}),
    withPinnedConnection: params.withPinnedConnection,
    async initialize() {
      await (await params.createRequestSnapshot().index()).initialize();
    },
    requireEligibleThread: (threadId) =>
      requireEligibleCodexThread({
        threadId,
        requests: params.createRequestSnapshot(),
        localSessionsRoot: params.localSessionsRoot,
        sourceHomeId: params.sourceHomeId,
        managedThreads: params.managedThreads,
        now: params.now,
      }),
    retireConnection: params.retireConnection,
    async listPage(pageParams) {
      readControlCursor(pageParams.cursor, "request");
      const query = readPageParams(pageParams);
      return await withCodexCatalogListRequest(async (request) => {
        const requests = params.createRequestSnapshot();
        // Release foreground admission while index-owned hydration continues.
        const timeoutMs = Math.min(requests.requestTimeoutMs, 5_000);
        const deadline = request.constrainDeadline(performance.now() + timeoutMs);
        const index = await requests.index();
        return await index.list(query, deadline);
      });
    },
    async listDescendantPage(listParams) {
      const requests = params.createRequestSnapshot();
      return await requests.listThreads(listParams, requests.requestTimeoutMs);
    },
    async readThread(threadId, includeTurns = false) {
      return await params.createRequestSnapshot().readThread(threadId, includeTurns);
    },
    async listTurnPage(listParams) {
      return await params.createRequestSnapshot().listThreadTurns(listParams);
    },
    listItemPage: (listParams) => params.createRequestSnapshot().listThreadItems(listParams),
    async forkThread(forkParams, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = forkParams.ephemeral === true ? undefined : await requests.index();
      const response = await requests.forkThread(forkParams, assertCurrent);
      if (index && !index.get(response.thread.id)) {
        await index.upsertThread(response.thread);
      }
      return response;
    },
    async archiveThread(threadId, assertCurrent) {
      const requests = params.createRequestSnapshot();
      const index = await requests.index();
      await requests.archiveThread(threadId, assertCurrent);
      index.archive(threadId);
    },
  };
}

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
  const indexes = new Map<string, CodexCatalogIndex>();
  const directHomes = new Map<string, Promise<string>>();
  const residentRequests = new Set<Promise<CodexCatalogIndex>>();
  let generation = params.config;
  let closed = false;
  let runBackground = (run: () => Promise<void>) => run();
  let retiring: Promise<void> | undefined;
  const retireIndexes = (): Promise<void> => {
    const closing: Promise<void>[] = [];
    for (const index of indexes.values()) {
      closing.push(index.close());
    }
    indexes.clear();
    directHomes.clear();
    const drain = Promise.allSettled([retiring, ...closing]).then(() => {
      if (retiring === drain) {
        retiring = undefined;
      }
    });
    retiring = drain;
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
    const runtime =
      source?.appServer ??
      resolveRuntimeOptions({ pluginConfig: readCodexPluginConfig(params.getPluginConfig()) });
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
    let index = indexes.get(homeId);
    if (!index) {
      const [
        { CodexCatalogIndex },
        { canReuseCodexCatalogPreview, projectCodexCatalogDeltaPage, projectCodexCatalogPage },
      ] = await Promise.all([
        import("./session-catalog-index.js"),
        import("./session-catalog-projection.js"),
      ]);
      if (closed) {
        throw new Error("Codex resident catalog is closed");
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
      // A smaller wire limit belongs to this resident home and resets with its index.
      let nativePageLimit = Infinity;
      index = new CodexCatalogIndex({
        homeId,
        requestTimeoutMs: runtime.requestTimeoutMs,
        runBackground: (run) => runBackground(run),
        localSessionsRoot: root,
        state: params.openResidentState?.(homeId),
        runNativeWalk: async (run) => {
          try {
            const result = await run();
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
          if (closed) {
            throw new Error("Codex resident catalog is closed");
          }
        },
        readNative: async (query, remainingRows, foreground) => {
          source?.assertCurrent();
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
            Math.min(64, remainingRows),
            requestOptions,
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
          let observation: ReturnType<typeof startCodexCatalogControlRequestDiagnostics>;
          let outcome: "resolved" | "rejected" = "rejected";
          try {
            const started = performance.now();
            const deadline =
              started +
              (foreground?.remaining(requests.requestTimeoutMs) ?? requests.requestTimeoutMs);
            let response: CodexThreadListResponse;
            try {
              let limit = Math.min(query.limit ?? 16, nativePageLimit);
              for (;;) {
                foreground?.assertActive();
                source?.assertCurrent();
                if (diagnostics) {
                  diagnostics.fields.controlRequestCalls += 1;
                }
                observation = startCodexCatalogControlRequestDiagnostics(diagnostics);
                try {
                  response = await requests.listThreads(
                    { ...query, limit },
                    remainingCodexRequestTime("thread/list", undefined, deadline),
                    observation,
                  );
                  break;
                } catch (error) {
                  observation?.rejected();
                  observation?.close();
                  // Retry only this read-only page, at the same cursor and within its deadline.
                  if (!CodexCatalogResponseTooLargeError.fromError(error) || limit <= 1) {
                    throw error;
                  }
                  nativePageLimit = limit = Math.max(1, Math.floor(limit / 2));
                }
              }
            } finally {
              if (diagnostics) {
                const elapsed = performance.now() - started;
                diagnostics.fields.inclusiveControlRequestWaitMs = elapsed;
                diagnostics.fields.inclusiveControlRequestWaitMaxMs = elapsed;
              }
            }
            foreground?.assertActive();
            const bounded = { ...response, data: response.data.slice(0, remainingRows) };
            const projection = {
              localSessionsRoot: root,
              diagnostics,
            };
            const page = query.useStateDbOnly
              ? await projectCodexCatalogDeltaPage(bounded, {
                  ...projection,
                  getRow: (threadId) => index?.get(threadId),
                })
              : await projectCodexCatalogPage(bounded, projection);
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
        },
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
    // Keep owner-published config and prepared connection facts without copying them.
    return {
      agentDir:
        source?.agentDir ?? (agentId ? resolveAgentDir(runtimeConfig ?? {}, agentId) : undefined),
      config: runtimeConfig,
      startOptions: source?.appServer.start ?? startOptions,
    };
  };
  const createRequestSnapshot = (
    agentId: string | undefined,
    source?: CodexCatalogControlSource,
    catalogPreview?: true,
    catalogPreviewCache?: CodexCatalogPreviewCache,
    catalogRows?: number,
    preparedRequestOptions?: CodexCatalogRequestOptions,
  ): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = readCodexPluginConfig(params.getPluginConfig());
    const runtime = source?.appServer ?? resolveRuntimeOptions({ pluginConfig });
    const requestOptions =
      preparedRequestOptions ?? resolveRequestOptions(runtime.start, agentId, source);
    return createCodexCatalogRequestSnapshot(
      runtime.requestTimeoutMs,
      async (method, requestParams, timeoutMs, assertCurrent, observation) => {
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
    const withPinnedConnection: CodexSessionCatalogControl["withPinnedConnection"] = async (
      run,
    ) => {
      const pluginConfig = readCodexPluginConfig(params.getPluginConfig());
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
            clientId: client.getInstanceId(),
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
      residentRequests.size > 0 ||
      retiring !== undefined ||
      hasActiveSharedCodexAppServerWork() ||
      [...indexes.values()].some((index) => index.hasActiveWork()),
    async disconnect() {
      await retireIndexes();
      await Promise.allSettled(residentRequests);
      // Node disconnect owns these transports; Gateway service retirement does not.
      const clients = getSharedCodexAppServerClientState();
      if (clients.liveClients.size > 0 || clients.startup.pending.size > 0) {
        const { clearSharedCodexAppServerClientAndWait } =
          await import("./app-server/shared-client.js");
        await clearSharedCodexAppServerClientAndWait();
      }
    },
    async start() {
      // Capture service authority without opening every configured home's native
      // client. The first authorized catalog request owns hydration admission.
      const serviceScope = AsyncLocalStorage.snapshot();
      runBackground = (run) => serviceScope(run);
    },
    async stop() {
      closed = true;
      await retireIndexes();
      await Promise.allSettled(residentRequests);
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
