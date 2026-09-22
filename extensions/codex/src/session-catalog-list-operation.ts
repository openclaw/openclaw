import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogEntrySnapshot,
  SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { publishSessionCatalogHost } from "openclaw/plugin-sdk/session-catalog-paging";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { currentCodexCatalogListDiagnostics } from "./session-catalog-diagnostics.js";
import type { CodexCatalogHome } from "./session-catalog-homes.js";
import {
  catalogError,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  MAX_HOST_COUNT,
  readGatewayParams,
} from "./session-catalog-parsing.js";
import { codexNodeTerminalCapability } from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogHost,
  CodexSessionCatalogPage,
  CodexSessionCatalogParams,
  CodexSessionCatalogResult,
} from "./session-catalog-types.js";
import { CodexCatalogVisiblePage } from "./session-catalog-visible-page.js";

type ListParams = {
  agentId?: string;
  bindingStore: CodexAppServerBindingStore;
  config?: OpenClawConfig;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControlFactory;
  query?: CodexSessionCatalogParams;
  listNodes?: Parameters<SessionCatalogProvider["list"]>[0]["listNodes"];
  onHost?: (host: CodexSessionCatalogHost) => void;
  waitUntil?: (completion: Promise<void>) => void;
  signal?: AbortSignal;
  sessionEntries?: SessionCatalogEntrySnapshot;
  includeLocal?: boolean;
  localHomes?: CodexCatalogHome[];
};

type ListStep<THost> = { done: false } | { done: true; hosts: THost[] };
type ListOperation<THost> = {
  next: () => Promise<ListStep<THost>>;
  close: () => void;
};
type LocalHost = {
  source?: CodexCatalogHome;
  page: CodexCatalogVisiblePage;
  completion: ReturnType<typeof createDeferred<CodexSessionCatalogHost>>;
  value?: CodexSessionCatalogHost;
  active?: Promise<void>;
};

type PreparedList = {
  agentId: string;
  query: ReturnType<typeof readGatewayParams>;
  requestedHostIds?: Set<string>;
};

function hostFailure(
  source: CodexCatalogHome | undefined,
  error: unknown,
): CodexSessionCatalogHost {
  return {
    hostId: source?.hostId ?? CODEX_LOCAL_SESSION_HOST_ID,
    label: source?.label ?? "Local Codex",
    kind: "gateway",
    connected: false,
    sessions: [],
    error: catalogError("APP_SERVER_UNAVAILABLE", error),
  };
}

async function projectLocalHost(
  params: ListParams,
  agentId: string,
  source: CodexCatalogHome | undefined,
  page: CodexSessionCatalogPage,
): Promise<CodexSessionCatalogHost> {
  params.signal?.throwIfAborted();
  const { listAdoptedSessionEntries } = await import("./session-catalog-adoption.js");
  const { sessionCatalogAdoptedSourceKey } = await import("openclaw/plugin-sdk/session-catalog");
  params.signal?.throwIfAborted();
  const diagnostics = currentCodexCatalogListDiagnostics();
  const started = diagnostics ? performance.now() : 0;
  if (diagnostics) {
    diagnostics.fields.adoptionCalls++;
  }
  let adopted: Awaited<ReturnType<typeof listAdoptedSessionEntries>>;
  try {
    adopted = await listAdoptedSessionEntries({
      agentId,
      bindingStore: params.bindingStore,
      config: params.config,
      runtime: params.runtime,
      sessionEntries: params.sessionEntries,
    });
  } finally {
    if (diagnostics && !diagnostics.closed) {
      diagnostics.fields.adoptionSumMs =
        (diagnostics.fields.adoptionSumMs ?? 0) + performance.now() - started;
    }
  }
  const hostId = source?.hostId ?? CODEX_LOCAL_SESSION_HOST_ID;
  const sourceHomeId = source?.sourceHomeId ?? CODEX_LOCAL_SESSION_HOST_ID;
  return {
    hostId,
    label: source?.label ?? "Local Codex",
    kind: "gateway",
    connected: true,
    ...page,
    sessions: page.sessions.map((session) => {
      const entry =
        adopted.get(sessionCatalogAdoptedSourceKey(sourceHomeId, session.threadId)) ??
        (hostId === CODEX_LOCAL_SESSION_HOST_ID
          ? adopted.get(
              sessionCatalogAdoptedSourceKey(CODEX_LOCAL_SESSION_HOST_ID, session.threadId),
            )
          : undefined);
      const sourced = source ? { ...session, sourceHomeId: source.sourceHomeId } : session;
      return entry ? { ...sourced, sessionKey: entry.key } : sourced;
    }),
  };
}

function managedMarker(
  store: NonNullable<CodexAppServerBindingStore["managedThreads"]>,
  sourceHomeId: string,
  managed: ReadonlySet<string> | undefined,
) {
  return async ({ threadId, rolloutPath }: { threadId: string; rolloutPath?: string }) => {
    if (managed?.has(threadId)) {
      return;
    }
    const diagnostics = currentCodexCatalogListDiagnostics();
    const started = diagnostics ? performance.now() : 0;
    if (diagnostics) {
      diagnostics.fields.exclusionMarkCalls++;
    }
    try {
      await store.mark({ sourceHomeId, threadId, ...(rolloutPath ? { rolloutPath } : {}) });
    } finally {
      if (diagnostics && !diagnostics.closed) {
        diagnostics.fields.exclusionMarkSumMs =
          (diagnostics.fields.exclusionMarkSumMs ?? 0) + performance.now() - started;
      }
    }
  };
}

function createNodePublicationTracker(
  publications: { pending: number },
  waitUntil: ListParams["waitUntil"],
) {
  const settled = () => {
    publications.pending--;
  };
  return (completion: Promise<void>) => {
    publications.pending++;
    // Keep long-lived node callbacks outside the driver's request scope.
    void completion.then(settled, settled);
    waitUntil?.(completion);
  };
}

/** Holds only one logical filled list; no native producer is suspended between next calls. */
class CodexCatalogListDriver {
  private params: ListParams | undefined;
  private prepared: PreparedList | undefined;
  private locals: LocalHost[] = [];
  private nodeHosts: CodexSessionCatalogHost[] | undefined;
  private nodeActive = false;
  private nodeDiscoveryFailed = false;
  private readonly nodePublications = { pending: 0 };
  private nodesStarted = false;
  private localFailed = false;
  private active = 0;
  private running = false;
  private complete = false;
  private failure: { error: unknown } | undefined;
  private step: ReturnType<typeof createDeferred<ListStep<CodexSessionCatalogHost>>> | undefined;

  constructor(params: ListParams) {
    this.params = params;
  }

  private request(): ListParams {
    if (!this.params) {
      throw new Error("Codex catalog list operation is closed");
    }
    return this.params;
  }

  private selection(): PreparedList {
    if (!this.prepared) {
      throw new Error("Codex catalog list operation is not initialized");
    }
    return this.prepared;
  }

  private async initialize(): Promise<void> {
    const params = this.request();
    const agentId = resolveSessionAgentIdsStrict({
      config: params.config ?? {},
      agentId: params.agentId,
    }).sessionAgentId;
    const query = readGatewayParams(params.query);
    const requestedHostIds = query.hostIds ? new Set(query.hostIds) : undefined;
    const localSources =
      params.localHomes?.filter(
        (source) => !requestedHostIds || requestedHostIds.has(source.hostId),
      ) ??
      (params.includeLocal !== false &&
      (!requestedHostIds || requestedHostIds.has(CODEX_LOCAL_SESSION_HOST_ID))
        ? [undefined]
        : []);
    const diagnostics = currentCodexCatalogListDiagnostics();
    if (diagnostics) {
      diagnostics.fields.localHostCount = localSources.length;
    }
    const store = params.bindingStore.managedThreads;
    const started = diagnostics && store ? performance.now() : 0;
    let managed: Awaited<ReturnType<NonNullable<typeof store>["snapshot"]>> | undefined;
    try {
      managed = await store?.snapshot();
    } finally {
      if (diagnostics && !diagnostics.closed && store) {
        diagnostics.fields.managedSnapshotMs = performance.now() - started;
      }
    }
    params.signal?.throwIfAborted();
    const fallback = localSources.some((source) => source === undefined)
      ? (await params.control.homesForAgent(agentId))[0]
      : undefined;
    params.signal?.throwIfAborted();
    this.prepared = { agentId, query, requestedHostIds };
    if (requestedHostIds && !query.hostIds?.some((host) => host.startsWith("node:"))) {
      this.nodeHosts = [];
    }
    for (const source of localSources) {
      const selected = source ?? fallback;
      const excluded = selected ? managed?.get(selected.sourceHomeId) : undefined;
      const host: LocalHost = {
        source,
        page: new CodexCatalogVisiblePage({
          control: params.control.forRequest(agentId, selected),
          cursor: query.cursors?.[source?.hostId ?? CODEX_LOCAL_SESSION_HOST_ID],
          limit: query.limitPerHost,
          excludedThreadIds: excluded,
          searchTerm: query.search,
          signal: params.signal,
          ...(selected && store
            ? { onExcludedThread: managedMarker(store, selected.sourceHomeId, excluded) }
            : {}),
        }),
        completion: createDeferred<CodexSessionCatalogHost>(),
      };
      this.locals.push(host);
      // Register before starting any pages; close can settle an inert host if registration fails.
      publishSessionCatalogHost(params, host.completion.promise);
    }
  }

  private canPause(): boolean {
    return (
      !this.localFailed &&
      this.nodeHosts !== undefined &&
      !this.nodeDiscoveryFailed &&
      !this.nodeActive &&
      this.nodePublications.pending === 0
    );
  }

  private async readHost(host: LocalHost): Promise<void> {
    const params = this.request();
    try {
      const page = await host.page.next();
      params.signal?.throwIfAborted();
      if (page.done) {
        host.value = await projectLocalHost(
          params,
          this.selection().agentId,
          host.source,
          page.page,
        );
      }
    } catch (error) {
      this.localFailed = true;
      host.value = hostFailure(host.source, error);
    }
    if (host.value) {
      host.completion.resolve(host.value);
    }
  }

  private startHost(host: LocalHost): void {
    if (host.value || host.active || this.failure) {
      return;
    }
    this.active++;
    host.active = this.readHost(host).then(
      () => {
        host.active = undefined;
        this.active--;
        // Keep a fast home's original independent progress while any sibling is still active.
        if (!host.value && (!this.canPause() || this.active > 0)) {
          this.startHost(host);
        }
        this.checkpoint();
      },
      (error: unknown) => {
        host.active = undefined;
        this.active--;
        this.failure ??= { error };
        this.checkpoint();
      },
    );
  }

  private async readNodes(): Promise<CodexSessionCatalogHost[]> {
    const params = this.request();
    const { agentId, query, requestedHostIds } = this.selection();
    const diagnostics = currentCodexCatalogListDiagnostics();
    const started = diagnostics ? performance.now() : 0;
    if (diagnostics) {
      diagnostics.fields.nodeRegistryCalls = 1;
    }
    let nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
    try {
      try {
        nodes = (await (params.listNodes?.() ?? params.runtime.nodes.list())).nodes
          .filter(
            (node) =>
              node.gatewayLocal !== true &&
              (node.commands?.includes(CODEX_APP_SERVER_THREADS_LIST_COMMAND) ||
                codexNodeTerminalCapability(node).canStartTerminal) &&
              (!requestedHostIds || requestedHostIds.has(`node:${node.nodeId}`)),
          )
          .slice(0, MAX_HOST_COUNT - this.locals.length);
      } finally {
        if (diagnostics && !diagnostics.closed) {
          diagnostics.fields.nodeRegistryMs = performance.now() - started;
        }
      }
    } catch (error) {
      this.nodeDiscoveryFailed = true;
      const host: CodexSessionCatalogHost = {
        hostId: "node:registry",
        label: "Paired nodes",
        kind: "node",
        connected: false,
        canStartTerminal: false,
        sessions: [],
        error: catalogError("NODE_LIST_FAILED", error),
      };
      params.onHost?.(host);
      return [host];
    }
    params.signal?.throwIfAborted();
    const { listNodeAdoptedSessionEntries } = await import("./session-catalog-node-adoption.js");
    const { compareNodeLabels, listPairedNode } =
      await import("./session-catalog-node-continue.js");
    params.signal?.throwIfAborted();
    const adopted = listNodeAdoptedSessionEntries({
      agentId,
      config: params.config,
      runtime: params.runtime,
      sessionEntries: params.sessionEntries,
    });
    if (diagnostics && !diagnostics.closed) {
      diagnostics.fields.pairedNodeCalls = 0;
      diagnostics.fields.pairedNodeSettled = 0;
    }
    const trackPublication = createNodePublicationTracker(this.nodePublications, params.waitUntil);
    const pendingHosts = nodes.toSorted(compareNodeLabels).map((node) => {
      const nodeStarted = diagnostics ? performance.now() : 0;
      if (diagnostics && !diagnostics.closed) {
        diagnostics.fields.pairedNodeCalls = (diagnostics.fields.pairedNodeCalls ?? 0) + 1;
      }
      const host = listPairedNode({
        agentId,
        runtime: params.runtime,
        node,
        query,
        adoptedSessions: adopted,
        terminalCapabilities: codexNodeTerminalCapability(node),
        waitUntil: trackPublication,
        signal: params.signal,
        ...(params.onHost ? { onHost: params.onHost } : {}),
      });
      return diagnostics
        ? host.finally(() => {
            if (!diagnostics.closed) {
              diagnostics.fields.pairedNodeSettled =
                (diagnostics.fields.pairedNodeSettled ?? 0) + 1;
              diagnostics.fields.nodeWaitSumMs =
                (diagnostics.fields.nodeWaitSumMs ?? 0) + performance.now() - nodeStarted;
            }
          })
        : host;
    });
    try {
      return await Promise.all(pendingHosts);
    } catch (error) {
      // A fatal callback still owns every started node's fail-soft foreground result.
      await Promise.allSettled(pendingHosts);
      throw error;
    }
  }

  private startNodes(): void {
    if (this.nodeHosts !== undefined || this.nodesStarted) {
      return;
    }
    this.nodesStarted = true;
    this.nodeActive = true;
    void this.readNodes().then(
      (hosts) => {
        this.nodeHosts = hosts;
        this.nodeActive = false;
        this.checkpoint();
      },
      (error: unknown) => {
        this.nodeActive = false;
        this.failure ??= { error };
        this.checkpoint();
      },
    );
  }

  private checkpoint(): void {
    if (this.active > 0 || !this.step) {
      return;
    }
    if (this.failure) {
      if (!this.nodeActive) {
        this.step.reject(this.failure.error);
      }
    } else if (this.nodeHosts && this.locals.every((host) => host.value !== undefined)) {
      this.complete = true;
      this.step.resolve({
        done: true,
        hosts: [
          ...this.locals.flatMap((host) => (host.value ? [host.value] : [])),
          ...this.nodeHosts,
        ],
      });
    } else if (this.canPause()) {
      this.step.resolve({ done: false });
    }
  }

  async next(): Promise<ListStep<CodexSessionCatalogHost>> {
    const params = this.request();
    if (this.running || this.complete) {
      throw new Error("Codex catalog list operation cannot advance");
    }
    params.signal?.throwIfAborted();
    this.running = true;
    try {
      if (!this.prepared) {
        await this.initialize();
      }
      this.step = createDeferred<ListStep<CodexSessionCatalogHost>>();
      for (const host of this.locals) {
        this.startHost(host);
      }
      this.startNodes();
      this.checkpoint();
      return await this.step.promise;
    } finally {
      this.running = false;
      this.step = undefined;
    }
  }

  close(): void {
    if (!this.params) {
      return;
    }
    if (this.running) {
      throw new Error("Cannot close an active Codex catalog list step");
    }
    const reason =
      this.failure?.error ??
      this.params.signal?.reason ??
      new Error("Codex catalog list operation closed");
    this.params = undefined;
    for (const host of this.locals) {
      if (!host.value) {
        host.completion.reject(reason);
      }
    }
    this.locals = [];
    this.prepared = undefined;
    this.nodeHosts = undefined;
    this.failure = undefined;
  }
}

export function createCodexSessionCatalogListOperation(
  params: ListParams,
): ListOperation<CodexSessionCatalogHost> {
  const driver = new CodexCatalogListDriver(params);
  return { next: () => driver.next(), close: () => driver.close() };
}

export async function runCatalogListInline<THost>(
  operation: ListOperation<THost>,
): Promise<THost[]> {
  try {
    for (;;) {
      const step = await operation.next();
      if (step.done) {
        return step.hosts;
      }
    }
  } finally {
    operation.close();
  }
}

export async function listCodexSessionCatalog(
  params: ListParams,
): Promise<CodexSessionCatalogResult> {
  return { hosts: await runCatalogListInline(createCodexSessionCatalogListOperation(params)) };
}
