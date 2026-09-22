import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import type { CodexManagedThreadStore } from "./app-server/managed-thread-store.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import { assertCodexThreadForkParams } from "./app-server/protocol.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  CodexThread,
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadListParams,
  CodexThreadListResponse,
  CodexThreadItemsListParams,
  CodexThreadItemsListResponse,
  CodexThreadTurnsListParams,
  CodexThreadTurnsListResponse,
} from "./app-server/protocol.js";
import type { CodexControlRequestObservation } from "./app-server/request-observation.js";
import { withTimeout } from "./app-server/timeout.js";
import {
  currentCodexCatalogListDiagnostics,
  startCodexCatalogPageDiagnostics,
  startCodexCatalogControlRequestDiagnostics,
  waitForCodexCatalogPage,
} from "./session-catalog-diagnostics.js";
import { createCodexCatalogHomeResolver, type CodexCatalogHome } from "./session-catalog-homes.js";
import {
  CodexCatalogIndex,
  createCodexCatalogIndexResolver,
  CODEX_CATALOG_CACHE_TTL_MS,
} from "./session-catalog-index.js";
import {
  codexCatalogPageCacheKey,
  retainCodexCatalogPage,
  type CodexCatalogPageCacheEntry,
} from "./session-catalog-page-cache.js";
import {
  MAX_ACTION_CATALOG_PAGES,
  MAX_TITLE_SEARCH_CATALOG_PAGES,
  filterCatalogPageByTitle,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  CatalogParamsError,
  isInteractiveThreadSource,
  readPageParams,
  readControlCursor,
} from "./session-catalog-parsing.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import { readCodexSessionMeta } from "./session-catalog-provenance.js";
import { CodexCatalogSourceBackoff } from "./session-catalog-source-backoff.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogPage,
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

type CodexCatalogPendingPage = {
  page: Promise<CodexSessionCatalogPage>;
  staleValue?: CodexSessionCatalogPage;
  producerOperationId?: string;
  headWalk: boolean;
};

type CodexCatalogPageCache = {
  settled: Map<string, CodexCatalogPageCacheEntry>;
  pending: Map<string, CodexCatalogPendingPage>;
};

type CodexSessionCatalogRequestSnapshot = {
  beginList: () => ReturnType<CodexCatalogSourceBackoff["begin"]>;
  index: (cwd?: string) => CodexCatalogIndex;
  requestTimeoutMs: number;
  listThreads(
    params: CodexThreadListParams,
    timeoutMs: number,
    observation?: CodexControlRequestObservation,
  ): Promise<CodexThreadListResponse>;
  listThreadTurns(params: CodexThreadTurnsListParams): Promise<CodexThreadTurnsListResponse>;
  listThreadItems(params: CodexThreadItemsListParams): Promise<CodexThreadItemsListResponse>;
  forkThread(
    params: CodexThreadForkParams,
    assertCurrent?: () => void,
  ): Promise<CodexThreadForkResponse>;
  readThread(threadId: string, includeTurns: boolean, timeoutMs?: number): Promise<CodexThread>;
  archiveThread(threadId: string, assertCurrent?: () => void): Promise<void>;
};

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
  index: (cwd?: string) => CodexCatalogIndex,
  beginList: CodexSessionCatalogRequestSnapshot["beginList"],
): CodexSessionCatalogRequestSnapshot {
  return {
    index,
    beginList,
    requestTimeoutMs,
    listThreads: (params, timeoutMs, observation) =>
      request(CODEX_CONTROL_METHODS.listThreads, params, timeoutMs, undefined, observation),
    listThreadTurns: (params) => request(CODEX_CONTROL_METHODS.listThreadTurns, params),
    listThreadItems: (params) => request(CODEX_CONTROL_METHODS.listThreadItems, params),
    forkThread: (params, assertCurrent) =>
      request(
        CODEX_CONTROL_METHODS.forkThread,
        assertCodexThreadForkParams(params),
        undefined,
        assertCurrent,
      ),
    readThread: async (threadId, includeTurns, timeoutMs) =>
      (await request(CODEX_CONTROL_METHODS.readThread, { threadId, includeTurns }, timeoutMs))
        .thread,
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
  createRequestSnapshot: (
    pageParams?: CodexSessionCatalogPageParams,
  ) => CodexSessionCatalogRequestSnapshot;
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
    async requireEligibleThread(threadId) {
      const requests = params.createRequestSnapshot();
      const deadline = params.now() + requests.requestTimeoutMs;
      const unverified = () =>
        new CatalogParamsError(
          "Codex session eligibility could not be verified. Refresh the catalog and verify the session in its native Codex home before retrying.",
        );
      const remaining = () => {
        const timeoutMs = Math.ceil(deadline - params.now());
        if (timeoutMs <= 0) {
          throw unverified();
        }
        return timeoutMs;
      };
      const verify = async () => {
        if (
          params.sourceHomeId &&
          (await params.managedThreads?.has(params.sourceHomeId, threadId))
        ) {
          throw unverified();
        }
        // Local exact reads seed missing native index rows before DB-only membership checks.
        // Remote/pathless stores retain native scan-and-repair membership: no local rollout authority.
        const root = params.localSessionsRoot;
        const thread = root ? await requests.readThread(threadId, false, remaining()) : undefined;
        if (
          root &&
          (!thread || thread.id !== threadId || !isInteractiveThreadSource(thread.source))
        ) {
          throw unverified();
        }
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
          const page = await requests.listThreads(
            {
              archived: false,
              limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
              modelProviders: [],
              sortKey: root ? "recency_at" : "updated_at",
              sortDirection: "desc",
              ...(root
                ? { useStateDbOnly: true, ...(thread?.cwd ? { cwd: thread.cwd } : {}) }
                : {}),
              ...(cursor ? { cursor } : {}),
            },
            remaining(),
          );
          remaining();
          const candidate = page.data.find((value) => value.id === threadId);
          if (candidate) {
            if (!isInteractiveThreadSource(candidate.source)) {
              throw unverified();
            }
            if (root && thread) {
              const rolloutPath = thread.path;
              // Codex may retain the plain path after compressing the selected immutable rollout.
              if (
                !rolloutPath ||
                !candidate.path ||
                rolloutPath.replace(/\.zst$/u, "") !== candidate.path.replace(/\.zst$/u, "")
              ) {
                throw unverified();
              }
              const metadata = await readCodexSessionMeta(root, rolloutPath, threadId);
              remaining();
              if (
                !metadata ||
                !isInteractiveThreadSource(metadata.source) ||
                metadata.originator === "openclaw"
              ) {
                throw unverified();
              }
              return thread;
            }
            return candidate;
          }
          const nextCursor = readControlCursor(page.nextCursor, "next response");
          if (!nextCursor || seenCursors.has(nextCursor)) {
            throw unverified();
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        throw unverified();
      };
      return await withTimeout(
        verify(),
        requests.requestTimeoutMs,
        "Codex session eligibility could not be verified",
        unverified,
      );
    },
    retireConnection: params.retireConnection,
    async listPage(
      pageParams,
      diagnostics = startCodexCatalogPageDiagnostics("uncached"),
      options = {},
    ) {
      let outcome: "resolved" | "rejected" = "rejected";
      let sourceAttempt: ReturnType<CodexCatalogSourceBackoff["begin"]> | undefined;
      try {
        const maxScanPages = options?.maxScanPages ?? MAX_TITLE_SEARCH_CATALOG_PAGES;
        readControlCursor(pageParams.cursor, "request");
        const queryParams = readPageParams(pageParams);
        const requests = params.createRequestSnapshot(queryParams);
        const deadline = params.now() + requests.requestTimeoutMs;
        const { sanitizeTerminalText } = await import("openclaw/plugin-sdk/text-chunking");
        const readNative = async (query: CodexThreadListParams) => {
          const remainingTimeoutMs = Math.ceil(deadline - params.now());
          if (remainingTimeoutMs <= 0) {
            throw new Error("Codex session catalog listing timed out");
          }
          sourceAttempt ??= requests.beginList();
          if (!sourceAttempt.allowed) {
            throw sourceAttempt.error;
          }
          const started = performance.now();
          if (diagnostics) {
            diagnostics.fields.controlRequestCalls++;
          }
          const observation = startCodexCatalogControlRequestDiagnostics(diagnostics);
          let response: CodexThreadListResponse;
          try {
            response = await requests.listThreads(query, remainingTimeoutMs, observation);
          } catch (error) {
            observation?.rejected();
            throw error;
          } finally {
            observation?.close();
            if (diagnostics) {
              const elapsed = performance.now() - started;
              diagnostics.fields.inclusiveControlRequestWaitMs =
                (diagnostics.fields.inclusiveControlRequestWaitMs ?? 0) + elapsed;
              diagnostics.fields.inclusiveControlRequestWaitMaxMs = Math.max(
                diagnostics.fields.inclusiveControlRequestWaitMaxMs ?? 0,
                elapsed,
              );
            }
          }
          return await projectCodexCatalogPage(response, {
            localSessionsRoot: params.localSessionsRoot,
            diagnostics,
            sanitize: sanitizeTerminalText,
          });
        };
        const sessions: CodexSessionCatalogPage["sessions"] = [];
        const managedThreads: NonNullable<CodexSessionCatalogPage["managedThreads"]> = [];
        const search = queryParams.searchTerm?.trim();
        let cursor = queryParams.cursor;
        let backwardsCursor: string | undefined;
        const seen = new Set(cursor ? [cursor] : []);
        const maxPages = search ? maxScanPages : 1;
        let scannedPages = 0;
        let stopReason: "limit" | "exhausted" | "page-bound" = "page-bound";
        for (let i = 0; i < maxPages; i++) {
          const native = await requests.index(queryParams.cwd).list(
            {
              limit: queryParams.limit - sessions.length,
              ...(cursor ? { cursor } : {}),
            },
            readNative,
          );
          if (i === 0) {
            backwardsCursor = native.backwardsCursor;
          }
          scannedPages++;
          const page = filterCatalogPageByTitle(native, search);
          sessions.push(...page.sessions);
          managedThreads.push(...(native.managedThreads ?? []));
          cursor = native.nextCursor;
          if (!cursor || sessions.length >= queryParams.limit || !search) {
            stopReason = !cursor
              ? "exhausted"
              : sessions.length >= queryParams.limit
                ? "limit"
                : "page-bound";
            break;
          }
          if (seen.has(cursor)) {
            throw new Error("Codex session catalog returned a repeated search cursor");
          }
          seen.add(cursor);
        }
        const catalogPage: CodexSessionCatalogPage = {
          sessions,
          ...(scannedPages > 1 ? { scannedPages } : {}),
          ...(managedThreads.length ? { managedThreads } : {}),
          ...(cursor ? { nextCursor: cursor } : {}),
          ...(backwardsCursor ? { backwardsCursor } : {}),
        };
        if (diagnostics) {
          diagnostics.fields.stopReason = stopReason;
        }
        if (sourceAttempt?.allowed) {
          sourceAttempt.resolved();
        }
        outcome = "resolved";
        return catalogPage;
      } catch (error) {
        if (sourceAttempt?.allowed) {
          sourceAttempt.rejected(error);
        }
        throw error;
      } finally {
        diagnostics?.finish(outcome);
      }
    },
    async listDescendantPage(listParams) {
      const requests = params.createRequestSnapshot();
      const response = await requests.listThreads(listParams, requests.requestTimeoutMs);
      return response;
    },
    async readThread(threadId, includeTurns = false) {
      const thread = await params.createRequestSnapshot().readThread(threadId, includeTurns);
      return thread;
    },
    async listTurnPage(listParams) {
      const response = await params.createRequestSnapshot().listThreadTurns(listParams);
      return response;
    },
    listItemPage: (listParams) => params.createRequestSnapshot().listThreadItems(listParams),
    async forkThread(forkParams, assertCurrent) {
      return await params.createRequestSnapshot().forkThread(forkParams, assertCurrent);
    },
    async archiveThread(threadId, assertCurrent) {
      await params.createRequestSnapshot().archiveThread(threadId, assertCurrent);
    },
  };
}

/** Builds the passive catalog over the Codex plugin's canonical shared client. */
export function createCodexSessionCatalogControl(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  resolveRuntimeOptions: typeof resolveCodexSupervisionAppServerRuntimeOptions;
  now?: () => number;
  managedThreads?: CodexManagedThreadStore;
}): CodexSessionCatalogControlFactory {
  const now = params.now ?? Date.now;
  const sourceBackoff = new CodexCatalogSourceBackoff(now);
  const noConfig: OpenClawConfig = {};
  const getPluginConfig = () => params.getPluginConfig();
  const homeResolver = createCodexCatalogHomeResolver({
    config: params.config ?? {},
    getRuntimeConfig: params.getRuntimeConfig,
    getPluginConfig: params.getPluginConfig,
    resolveRuntimeOptions: params.resolveRuntimeOptions,
    ...(params.env ? { env: params.env } : {}),
  });
  const requestOptionsByConfig = new WeakMap<
    OpenClawConfig,
    Map<string, CodexCatalogRequestOptions>
  >();
  const catalogPagesByConfig = new WeakMap<OpenClawConfig, Map<string, CodexCatalogPageCache>>();
  const indexFor = createCodexCatalogIndexResolver({
    now,
  });
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
    pageParams?: CodexSessionCatalogPageParams,
  ): CodexSessionCatalogRequestSnapshot => {
    const pluginConfig = getPluginConfig();
    const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
    const requestOptions = resolveRequestOptions(runtime.start, agentId, source);
    const catalogListKey =
      pageParams && requestOptions.config
        ? { scope: requestOptions, key: `index:${JSON.stringify(pageParams.cwd?.trim() || null)}` }
        : undefined;
    return createCodexCatalogRequestSnapshot(
      runtime.requestTimeoutMs,
      async (method, requestParams, timeoutMs, assertCurrent, observation) => {
        const { codexControlRequest } = await import("./command-rpc.js");
        return await codexControlRequest(pluginConfig, method, requestParams, {
          ...requestOptions,
          authProfileId: null,
          assertCurrent,
          ...(observation ? { controlObservation: observation } : {}),
          ...(catalogListKey && method === CODEX_CONTROL_METHODS.listThreads
            ? { catalogListKey }
            : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
      (cwd) => indexFor(agentId, source, runtime, requestOptions.config, cwd),
      () => sourceBackoff.begin(requestOptions.config ?? noConfig, agentId, source?.sourceHomeId),
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
      const pluginConfig = getPluginConfig();
      const runtime = source?.appServer ?? params.resolveRuntimeOptions({ pluginConfig });
      const {
        agentDir,
        config: runtimeConfig,
        startOptions,
      } = resolveRequestOptions(runtime.start, agentId, source);
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
        timeoutMs: runtime.requestTimeoutMs,
      });
      try {
        const requests = createCodexCatalogRequestSnapshot(
          runtime.requestTimeoutMs,
          async <M extends CodexCatalogRequestMethod>(
            method: M,
            requestParams: CodexAppServerRequestParams<M>,
            timeoutMs?: number,
            assertCurrent?: () => void,
            observation?: CodexControlRequestObservation,
          ): Promise<CodexAppServerRequestResult<M>> =>
            await requestCodexAppServerClientJson<CodexAppServerRequestResult<M>>({
              client,
              method,
              requestParams,
              config: runtimeConfig,
              timeoutMs: timeoutMs ?? runtime.requestTimeoutMs,
              assertCurrent,
              ...(observation ? { controlObservation: observation } : {}),
            }),
          (cwd) => indexFor(agentId, source, runtime, runtimeConfig, cwd),
          () => sourceBackoff.begin(runtimeConfig ?? noConfig, agentId, source?.sourceHomeId),
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
      createRequestSnapshot: (pageParams) => createRequestSnapshot(agentId, source, pageParams),
      ...(source?.localSessionsRoot ? { localSessionsRoot: source.localSessionsRoot } : {}),
      now,
      withPinnedConnection,
    });
    return {
      ...control,
      requireEligibleThread: (threadId) =>
        withPinnedConnection((pinned) => pinned.requireEligibleThread(threadId)),
      async listPage(pageParams: CodexSessionCatalogPageParams, _diagnostics, options) {
        const headWalk = options?.headWalk ?? false;
        source?.assertCurrent();
        const listDiagnostics = currentCodexCatalogListDiagnostics();
        const runtimeConfig = params.getRuntimeConfig();
        if (!runtimeConfig) {
          return await control.listPage(pageParams, undefined, options);
        }
        let sources = catalogPagesByConfig.get(runtimeConfig);
        if (!sources) {
          sources = new Map();
          catalogPagesByConfig.set(runtimeConfig, sources);
        }
        // A full walk of other homes must not evict this source before its next poll.
        const sourceKey = JSON.stringify([agentId, source?.sourceHomeId ?? null]);
        let cache = sources.get(sourceKey);
        if (!cache) {
          cache = { settled: new Map(), pending: new Map() };
          sources.set(sourceKey, cache);
        }
        const key = codexCatalogPageCacheKey(
          pageParams,
          agentId,
          source?.sourceHomeId,
          options?.maxScanPages,
        );
        const pending = cache.pending.get(key);
        if (pending) {
          pending.headWalk ||= headWalk;
        }
        const cached = cache.settled.get(key);
        if (cached) {
          retainCodexCatalogPage(cache.settled, key, cached, headWalk);
          if (cached.expiresAt > now()) {
            if (listDiagnostics) {
              listDiagnostics.fields.freshHits++;
            }
            return cached.value;
          }
        }
        if (pending) {
          if (pending.staleValue) {
            if (listDiagnostics) {
              listDiagnostics.fields.staleHits++;
            }
            return pending.staleValue;
          }
          if (listDiagnostics) {
            listDiagnostics.fields.pendingJoins++;
          }
          return await waitForCodexCatalogPage(pending.page, pending.producerOperationId);
        }
        if (listDiagnostics) {
          if (cached) {
            listDiagnostics.fields.staleHits++;
            listDiagnostics.fields.refreshStarts++;
          } else {
            listDiagnostics.fields.coldStarts++;
          }
        }
        const diagnostics = startCodexCatalogPageDiagnostics(cached ? "refresh" : "cold");
        // Result eviction must not retire a live producer or its stale refresh value.
        // Pending entries belong only to started work and leave on every settlement.
        const page = control
          .listPage(pageParams, diagnostics ?? null, options)
          .then(
            (value) => {
              retainCodexCatalogPage(
                cache.settled,
                key,
                { value, expiresAt: now() + CODEX_CATALOG_CACHE_TTL_MS, head: false },
                cache.pending.get(key)?.headWalk ?? false,
              );
              return value;
            },
            (error: unknown) => {
              if (cached && cache.settled.get(key) === cached) {
                cached.expiresAt = now();
              }
              throw error;
            },
          )
          .finally(() => {
            cache.pending.delete(key);
          });
        cache.pending.set(key, {
          page,
          producerOperationId: diagnostics?.operationId,
          headWalk: headWalk || cached?.head === true,
          ...(cached ? { staleValue: cached.value } : {}),
        });
        // Expiry starts one background refresh. Passive callers keep the last settled page while
        // the next poll publishes success or retries failure.
        if (cached) {
          void page.catch(() => undefined);
          return cached.value;
        }
        return await page;
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
    forRequest,
    forUpstream,
    homesForAgent: homeResolver.forAgent,
    async forNode(agentId) {
      const source = await homeResolver.forNode(agentId);
      return {
        control: forRequest(source.agentId, source),
        sourceHomeId: source.sourceHomeId,
        codexHome: source.codexHome,
      };
    },
  };
}
