import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { resolveCodexCatalogCreateSession } from "./session-catalog-create.js";
import {
  currentCodexCatalogListDiagnostics,
  createCodexCatalogListScope,
} from "./session-catalog-diagnostics.js";
import type { CodexCatalogHome } from "./session-catalog-homes.js";
import {
  createCodexSessionCatalogListOperation,
  listCodexSessionCatalog,
  runCatalogListInline,
} from "./session-catalog-list-operation.js";
import { readCodexSessionTranscript } from "./session-catalog-listing.js";
import {
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  isInteractiveThreadSource,
  readGatewayParams,
} from "./session-catalog-parsing.js";
import {
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
  openCodexCatalogTerminal,
  resolveLocalCodexTerminalExecutable,
  startCodexCatalogTerminal,
  type CodexTerminalConfigSources,
} from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControlFactory,
  CodexSessionCatalogHost,
} from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";
import {
  codexUpstreamContinueResult,
  type CodexUpstreamBaseline,
} from "./session-upstream-marker.js";

export { createCodexSessionCatalogControl } from "./session-catalog-control.js";
export { createCodexSessionCatalogNodeHostCommands } from "./session-catalog-listing.js";
export {
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
} from "./session-catalog-parsing.js";

/** Allows read-only catalog and transcript commands on supported paired-node platforms. */
export function createCodexSessionCatalogNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [
        CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
        CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
        CODEX_TERMINAL_RESUME_COMMAND,
        CODEX_TERMINAL_START_COMMAND,
      ],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => {
        if (context.command === CODEX_TERMINAL_START_COMMAND) {
          return context.client?.scopes?.includes("operator.admin") &&
            context.config.gateway?.cliAgents?.enabled === true &&
            context.config.gateway?.terminal?.enabled !== false
            ? { ok: true }
            : {
                ok: false,
                message:
                  "Native terminal start requires operator.admin and enabled CLI agents and terminals",
              };
        }
        return context.command === CODEX_TERMINAL_RESUME_COMMAND
          ? { ok: true }
          : context.invokeNode();
      },
    },
  ];
}

function toGenericCatalogHost(
  host: CodexSessionCatalogHost,
  localTerminalAvailable: boolean,
): SessionCatalogHost {
  const local = isLocalCodexCatalogHost(host.hostId);
  return {
    hostId: host.hostId,
    label: host.label,
    kind: host.kind,
    connected: host.connected,
    ...(host.nodeId ? { nodeId: host.nodeId } : {}),
    sessions: host.sessions.map((session) => {
      const continuableStatus =
        !session.archived && (session.status === "idle" || session.status === "notLoaded");
      const canContinue =
        (local || host.canContinueCodex === true) &&
        continuableStatus &&
        isInteractiveThreadSource(session.source);
      const canArchive = local && continuableStatus && isInteractiveThreadSource(session.source);
      const canOpenTerminal =
        isInteractiveThreadSource(session.source) &&
        (local ? localTerminalAvailable : host.canOpenTerminalCodex === true);
      const name = session.name ?? session.fallbackName;
      return {
        threadId: session.threadId,
        ...(session.sourceHomeId ? { sourceHomeId: session.sourceHomeId } : {}),
        ...(name ? { name } : {}),
        ...(session.cwd ? { cwd: session.cwd } : {}),
        status: session.status,
        ...(session.createdAt != null ? { createdAt: session.createdAt } : {}),
        ...(session.updatedAt != null ? { updatedAt: session.updatedAt } : {}),
        ...(session.recencyAt != null ? { recencyAt: session.recencyAt } : {}),
        ...(session.source ? { source: session.source } : {}),
        ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
        ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        archived: session.archived,
        ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}),
        canContinue,
        canArchive,
        canOpenTerminal,
      };
    }),
    ...(host.nextCursor ? { nextCursor: host.nextCursor } : {}),
    ...(host.error ? { error: host.error } : {}),
  };
}

function isLocalCodexCatalogHost(hostId: string): boolean {
  return (
    hostId === CODEX_LOCAL_SESSION_HOST_ID || hostId.startsWith(`${CODEX_LOCAL_SESSION_HOST_ID}:`)
  );
}

function resolveLocalCatalogHomeForThread(params: {
  homes: CodexCatalogHome[];
  hostId: string;
  sourceHomeId?: string;
}): CodexCatalogHome {
  if (params.homes.length === 0) {
    throw new CatalogParamsError("local Codex sessions are unavailable in isolated state");
  }
  const exact = params.sourceHomeId
    ? params.homes.filter((home) => home.sourceHomeId === params.sourceHomeId)
    : params.homes.filter((home) => home.hostId === params.hostId);
  if (exact.length === 0 || (params.sourceHomeId && exact[0]?.hostId !== params.hostId)) {
    throw new CatalogParamsError("Codex session source home is unavailable");
  }
  return exact[0]!;
}

type CatalogListOperation = ReturnType<NonNullable<SessionCatalogProvider["createListOperation"]>>;

function withCatalogListScope(
  initialize: () => Promise<CatalogListOperation>,
): CatalogListOperation {
  let create: typeof initialize | undefined = initialize;
  let operation: CatalogListOperation | undefined;
  let scope: ReturnType<typeof createCodexCatalogListScope> | undefined;
  let running = false;
  let closed = false;
  let completed = false;
  return {
    async next() {
      if (closed || running) {
        throw new Error("Codex catalog list operation cannot advance");
      }
      running = true;
      try {
        scope ??= createCodexCatalogListScope();
        return await scope.run(async () => {
          if (create) {
            const initializeOnce = create;
            create = undefined;
            operation = await initializeOnce();
          }
          if (!operation) {
            throw new Error("Codex catalog list operation did not initialize");
          }
          const step = await operation.next();
          completed ||= step.done;
          return step;
        });
      } finally {
        running = false;
      }
    },
    close() {
      if (closed) {
        return;
      }
      if (running) {
        throw new Error("Cannot close an active Codex catalog list step");
      }
      closed = true;
      create = undefined;
      const current = operation;
      operation = undefined;
      const currentScope = scope;
      scope = undefined;
      try {
        if (currentScope) {
          currentScope.run(() => current?.close());
        }
      } finally {
        currentScope?.finish(completed ? "resolved" : "rejected");
      }
    },
  };
}

function catalogHostMapper(
  localTerminalAvailable: boolean,
  localHomes: readonly CodexCatalogHome[],
) {
  return (host: CodexSessionCatalogHost): SessionCatalogHost => {
    const diagnostics = currentCodexCatalogListDiagnostics();
    const started = diagnostics ? performance.now() : 0;
    try {
      return {
        ...toGenericCatalogHost(host, localTerminalAvailable),
        canStartTerminal:
          host.kind === "gateway"
            ? localTerminalAvailable &&
              host.hostId === CODEX_LOCAL_SESSION_HOST_ID &&
              localHomes.some(
                (home) => home.hostId === host.hostId && home.appServer.start.transport === "stdio",
              )
            : host.canStartTerminal === true,
      };
    } finally {
      if (diagnostics && !diagnostics.closed) {
        diagnostics.fields.mappingMs =
          (diagnostics.fields.mappingMs ?? 0) + performance.now() - started;
      }
    }
  };
}

function mappedHostPublisher(
  onHost: (host: SessionCatalogHost) => void,
  mapHost: (host: CodexSessionCatalogHost) => SessionCatalogHost,
) {
  return (host: CodexSessionCatalogHost) => onHost(mapHost(host));
}

function mapCatalogListOperation(
  operation: ReturnType<typeof createCodexSessionCatalogListOperation>,
  mapHost: (host: CodexSessionCatalogHost) => SessionCatalogHost,
): CatalogListOperation {
  return {
    async next() {
      const step = await operation.next();
      return step.done ? { done: true, hosts: step.hosts.map(mapHost) } : step;
    },
    close: () => operation.close(),
  };
}

function registerCodexSessionCatalog(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControlFactory;
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  resolveRuntimeOptions: CodexTerminalConfigSources["resolveRuntimeOptions"];
}): void {
  const catalogHomes = async (agentId: string, allowProcessHomeFallback?: boolean) => {
    const homes = await params.control.homesForAgent(agentId);
    return allowProcessHomeFallback === false
      ? homes.filter((home) => !home.usesProcessHomeFallback)
      : homes;
  };
  const resolveRequestAgentId = (agentId?: string) =>
    resolveSessionAgentIdsStrict({
      config: params.getRuntimeConfig() ?? (params.api.config as OpenClawConfig),
      agentId,
    }).sessionAgentId;
  const bindRequest = async (request: {
    agentId?: string;
    hostId: string;
    sourceHomeId?: string;
    allowProcessHomeFallback?: boolean;
  }) => {
    const agentId = resolveRequestAgentId(request.agentId);
    const source = isLocalCodexCatalogHost(request.hostId)
      ? resolveLocalCatalogHomeForThread({
          homes: [...(await catalogHomes(agentId, request.allowProcessHomeFallback))],
          hostId: request.hostId,
          ...(request.sourceHomeId ? { sourceHomeId: request.sourceHomeId } : {}),
        })
      : undefined;
    return { agentId, source, control: params.control.forRequest(agentId, source) };
  };
  const bindLocalRequest = async (request: Parameters<typeof bindRequest>[0]) => {
    const bound = await bindRequest(request);
    if (!bound.source) {
      throw new CatalogParamsError("Codex session catalog hostId is invalid");
    }
    return { ...bound, source: bound.source };
  };
  const checkUpstreamActivity = upstream.createChecker(params);
  const createListOperation: NonNullable<SessionCatalogProvider["createListOperation"]> = (query) =>
    withCatalogListScope(async () => {
      const {
        agentId: requestedAgentId,
        allowProcessHomeFallback,
        listNodes,
        onHost,
        waitUntil,
        signal,
        sessionEntries,
        ...gatewayQuery
      } = query;
      const agentId = resolveRequestAgentId(requestedAgentId);
      const selectedQuery = readGatewayParams(gatewayQuery);
      const localHomes =
        selectedQuery.hostIds && !selectedQuery.hostIds.some(isLocalCodexCatalogHost)
          ? []
          : [...(await catalogHomes(agentId, allowProcessHomeFallback))];
      const mapHost = catalogHostMapper(
        resolveLocalCodexTerminalExecutable() !== undefined,
        localHomes,
      );
      return mapCatalogListOperation(
        createCodexSessionCatalogListOperation({
          agentId,
          bindingStore: params.bindingStore,
          config: params.getRuntimeConfig(),
          runtime: params.api.runtime,
          control: params.control,
          query: selectedQuery,
          listNodes,
          waitUntil,
          signal,
          sessionEntries,
          localHomes,
          ...(onHost ? { onHost: mappedHostPublisher(onHost, mapHost) } : {}),
        }),
        mapHost,
      );
    });
  const provider: SessionCatalogProvider = {
    id: "codex",
    label: "Codex",
    supportsProcessHomeIsolation: true,
    resolveCreateSession: ({ agentId }) =>
      resolveCodexCatalogCreateSession(
        params.api.runtime.modelConfig,
        params.getRuntimeConfig() ?? (params.api.config as OpenClawConfig),
        agentId,
      ),
    list: (query) => runCatalogListInline(createListOperation(query)),
    createListOperation,
    read: async (request) => {
      const { agentId, source, control } = await bindRequest(request);
      return await readCodexSessionTranscript({
        agentId,
        runtime: params.api.runtime,
        control,
        hostId: request.hostId,
        threadId: request.threadId,
        cursor: request.cursor,
        limit: request.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT,
        ...(source ? { source } : {}),
      });
    },
    continueSession: async (request) => {
      const config = params.getRuntimeConfig();
      if (!config) {
        throw new Error("OpenClaw runtime config is unavailable");
      }
      if (request.hostId.startsWith("node:")) {
        const agentId = resolveRequestAgentId(request.agentId);
        return await continueNodeCodexSession({
          agentId,
          api: params.api,
          config,
          hostId: request.hostId,
          threadId: request.threadId,
          clientScopes: request.clientScopes,
        });
      }
      if (!isLocalCodexCatalogHost(request.hostId)) {
        throw new CatalogParamsError("Codex session catalog hostId is invalid");
      }
      const { agentId, source, control } = await bindLocalRequest(request);
      source.assertCurrent();
      let upstreamBaseline: (CodexUpstreamBaseline & { connectionFingerprint: string }) | undefined;
      const continued = await continueLocalCodexSession({
        agentId,
        api: params.api,
        bindingStore: params.bindingStore,
        config,
        control,
        threadId: request.threadId,
        hostId: source.hostId,
        sourceHomeId: source.sourceHomeId,
        ...(source.hostId === CODEX_LOCAL_SESSION_HOST_ID ? { allowLegacy: true } : {}),
        onContinued: (baseline) => {
          upstreamBaseline = baseline;
        },
      });
      return codexUpstreamContinueResult(continued.sessionKey, request.threadId, upstreamBaseline);
    },
    checkUpstreamActivity: async (probes, policy) => {
      const filtered: typeof probes = [];
      for (const probe of probes) {
        if (
          !isLocalCodexCatalogHost(probe.hostId) ||
          policy?.allowProcessHomeFallback !== false ||
          (await catalogHomes(probe.agentId, false)).some((home) => home.hostId === probe.hostId)
        ) {
          filtered.push(probe);
        }
      }
      return checkUpstreamActivity(filtered);
    },
    archive: async (request) => {
      const runnerConfirmation: unknown = request.confirmNoOtherRunner;
      if (runnerConfirmation !== true) {
        throw new CatalogParamsError(
          "archive requires confirmation that no other runner is active",
        );
      }
      if (!isLocalCodexCatalogHost(request.hostId)) {
        throw new CatalogParamsError("paired-node Codex sessions are view-only");
      }
      const config = params.getRuntimeConfig();
      if (!config) {
        throw new Error("OpenClaw runtime config is unavailable");
      }
      const { agentId, source, control } = await bindLocalRequest(request);
      source.assertCurrent();
      await archiveLocalCodexSession({
        agentId,
        bindingStore: params.bindingStore,
        config,
        control,
        runtime: params.api.runtime,
        threadId: request.threadId,
        hostId: source.hostId,
        sourceHomeId: source.sourceHomeId,
        ...(source.hostId === CODEX_LOCAL_SESSION_HOST_ID ? { allowLegacy: true } : {}),
      });
      return { ok: true };
    },
    openTerminal: async (request) => {
      const { agentId, source, control } = await bindRequest(request);
      return await openCodexCatalogTerminal({
        api: params.api,
        control,
        getPluginConfig: params.getPluginConfig,
        getRuntimeConfig: params.getRuntimeConfig,
        resolveRuntimeOptions: params.resolveRuntimeOptions,
        ...(source ? { source } : {}),
        ...request,
        agentId,
      });
    },
    startTerminalSession: async (request) => {
      if (!request.nodeId && request.hostId && request.hostId !== CODEX_LOCAL_SESSION_HOST_ID) {
        throw new CatalogParamsError(
          "Codex terminal host is unavailable; select the local machine or a connected node",
        );
      }
      const source = request.nodeId
        ? undefined
        : resolveLocalCatalogHomeForThread({
            homes: [...(await catalogHomes(request.agentId, request.allowProcessHomeFallback))],
            hostId: request.hostId ?? CODEX_LOCAL_SESSION_HOST_ID,
          });
      if (source && source.appServer.start.transport !== "stdio") {
        throw new CatalogParamsError("Native terminal start requires a local Codex source");
      }
      return await startCodexCatalogTerminal({
        getPluginConfig: params.getPluginConfig,
        getRuntimeConfig: params.getRuntimeConfig,
        resolveRuntimeOptions: params.resolveRuntimeOptions,
        ...request,
        source,
      });
    },
  };
  params.api.registerSessionCatalog(provider);
}

export const codexSessionCatalogRuntime = {
  register: registerCodexSessionCatalog,
  list: listCodexSessionCatalog,
  readTranscript: readCodexSessionTranscript,
  continueLocal: continueLocalCodexSession,
  continueNode: continueNodeCodexSession,
  archiveLocal: archiveLocalCodexSession,
};

async function continueLocalCodexSession(
  ...args: Parameters<typeof import("./session-catalog-adoption.js").continueLocalCodexSession>
) {
  const { continueLocalCodexSession: run } = await import("./session-catalog-adoption.js");
  return run(...args);
}

async function archiveLocalCodexSession(
  ...args: Parameters<typeof import("./session-catalog-archive.js").archiveLocalCodexSession>
) {
  const { archiveLocalCodexSession: run } = await import("./session-catalog-archive.js");
  return run(...args);
}

async function continueNodeCodexSession(
  ...args: Parameters<typeof import("./session-catalog-node-continue.js").continueNodeCodexSession>
) {
  const { continueNodeCodexSession: run } = await import("./session-catalog-node-continue.js");
  return run(...args);
}
