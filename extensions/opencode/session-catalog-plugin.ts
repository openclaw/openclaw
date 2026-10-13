import path from "node:path";
import process from "node:process";
import { resolveAcpSessionAvailability } from "openclaw/plugin-sdk/acp-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSessionCatalogFamily,
  createSessionCatalogNodeHostBindings,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { createAcpSessionCatalogAdoption } from "openclaw/plugin-sdk/session-catalog-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENCODE_LOCAL_SESSION_HOST_ID as LOCAL_HOST_ID,
  OPENCODE_NODE_INVOKE_TIMEOUT_MS as NODE_TIMEOUT_MS,
  OPENCODE_SESSIONS_CAPABILITY as CAPABILITY,
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT as MAX_PAGE_LIMIT,
  OPENCODE_SESSION_ID_PATTERN as SESSION_ID_PATTERN,
  OPENCODE_SESSION_READ_COMMAND,
  OPENCODE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";
import {
  isExactOpenCodeSessionCursor,
  listLocalOpenCodeSessionPage,
  readLocalOpenCodeTranscriptPage,
  requireLocalOpenCodeSession,
} from "./session-catalog.js";
import {
  checkOpenCodeUpstreamActivity,
  linkContinuedOpenCodeSession,
} from "./session-upstream-activity.js";

const MAX_HOSTS = 100;
const ACPX_BACKEND_ID = "acpx";
const OPENCODE_ACP_AGENT_ID = "opencode";
const OPENCODE_ADOPTED_SESSION_KEY_PREFIX = "plugin:opencode:catalog-adopt:";

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("OpenCode session parameters must be valid JSON", { cause: error });
  }
}

function fullConfigCatalogEnabled(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return true;
  }
  const entry = config.plugins.entries.opencode;
  if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.sessionCatalog)) {
    return true;
  }
  return entry.config.sessionCatalog.enabled !== false;
}

function isOpenCodeSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.sessionCatalog) ||
    pluginConfig.sessionCatalog.enabled !== false
  );
}

function openCodeUsesProcessHomeFallback(env: NodeJS.ProcessEnv): boolean {
  return !env.OPENCODE_DB?.trim() && !path.isAbsolute(env.XDG_DATA_HOME?.trim() ?? "");
}

function assertOpenCodeLocalAccess(hostId: string, allowProcessHomeFallback?: boolean): void {
  if (
    hostId === LOCAL_HOST_ID &&
    allowProcessHomeFallback === false &&
    openCodeUsesProcessHomeFallback(process.env)
  ) {
    throw new Error("local OpenCode sessions are unavailable in isolated state");
  }
}

function currentOpenCodeCatalogConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

async function loadContinuableOpenCodeSession(
  api: OpenClawPluginApi,
  threadId: string,
): Promise<SessionCatalogSession> {
  const page = await listLocalOpenCodeSessionPage(
    { searchTerm: threadId, limit: MAX_PAGE_LIMIT },
    { configIdentity: currentOpenCodeCatalogConfig(api), forceRefresh: true },
  ).catch(() => undefined);
  const session = page?.sessions.find((candidate) => candidate.threadId === threadId);
  if (!session) {
    throw new Error("OpenCode session is unavailable");
  }
  return session;
}

function createOpenCodeNodeHostBindings(api: OpenClawPluginApi) {
  const available = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) &&
    Boolean(
      resolveNodeHostExecutable("opencode", {
        env: { ...env, PATHEXT: env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM" },
        // An explicit empty PATHEXT suffix also allowed bare executables before consolidation.
        includeExtensionless: env.PATHEXT?.split(";").includes("") ?? false,
        strategy: "direct",
      }),
    );
  return createSessionCatalogNodeHostBindings({
    capability: CAPABILITY,
    listCommand: OPENCODE_SESSIONS_LIST_COMMAND,
    readCommand: OPENCODE_SESSION_READ_COMMAND,
    terminalCommand: OPENCODE_TERMINAL_RESUME_COMMAND,
    sessionIdPattern: SESSION_ID_PATTERN,
    executable: "opencode",
    hasActiveWork: () => false,
    args: (threadId) => ["--session", threadId],
    listAvailable: available,
    terminalAvailable: available,
    parseParams: parseNodeParams,
    list: (params) =>
      listLocalOpenCodeSessionPage(params, {
        configIdentity: currentOpenCodeCatalogConfig(api),
      }),
    read: readLocalOpenCodeTranscriptPage,
    requireSession: requireLocalOpenCodeSession,
    terminalIoRequiredMessage: "OpenCode terminal command requires duplex transport",
    terminalUnavailableMessage: "OpenCode CLI is unavailable",
    invalidThreadIdMessage: "INVALID_REQUEST: threadId is invalid",
  });
}

export function registerOpenCodeSessionCatalog(api: OpenClawPluginApi): void {
  if (!isOpenCodeSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  const adoption = createAcpSessionCatalogAdoption({
    api,
    config: () => currentOpenCodeCatalogConfig(api),
    catalogId: OPENCODE_ACP_AGENT_ID,
    hostId: LOCAL_HOST_ID,
    keyPrefix: OPENCODE_ADOPTED_SESSION_KEY_PREFIX,
    markerPluginId: "opencode",
    markerKey: "sessionCatalog",
    read: readLocalOpenCodeTranscriptPage,
  });
  const provider = createSessionCatalogFamily(
    {
      runtime: api.runtime,
      local: {
        hostId: LOCAL_HOST_ID,
        label: "Local OpenCode",
        available: (query) =>
          (query.allowProcessHomeFallback !== false ||
            !openCodeUsesProcessHomeFallback(process.env)) &&
          resolveNodeHostExecutable("opencode", {
            env: process.env,
            pathEnv: process.env.PATH ?? "",
            strategy: "fallback",
          }) !== undefined,
        list: (query) =>
          listLocalOpenCodeSessionPage(
            {
              limit: query.limitPerHost,
              ...(query.search ? { searchTerm: query.search } : {}),
              cursor: query.cursors?.[LOCAL_HOST_ID],
            },
            { configIdentity: currentOpenCodeCatalogConfig(api) },
          ),
        read: (request) =>
          readLocalOpenCodeTranscriptPage({
            threadId: request.threadId,
            ...(request.limit ? { limit: request.limit } : {}),
            ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
          }),
        assertAccess: assertOpenCodeLocalAccess,
      },
      node: {
        listCommand: OPENCODE_SESSIONS_LIST_COMMAND,
        readCommand: OPENCODE_SESSION_READ_COMMAND,
        terminalCommand: OPENCODE_TERMINAL_RESUME_COMMAND,
        timeoutMs: NODE_TIMEOUT_MS,
        maxHosts: MAX_HOSTS,
        maxPageLimit: MAX_PAGE_LIMIT,
        sessionIdPattern: SESSION_ID_PATTERN,
      },
      capabilities: {
        local: () => ({
          canContinue: resolveAcpSessionAvailability({
            config: currentOpenCodeCatalogConfig(api),
            backendId: ACPX_BACKEND_ID,
            agentId: OPENCODE_ACP_AGENT_ID,
          }).available,
          canOpenTerminal: true,
        }),
        node: (node) => {
          const commands = node.invocableCommands ?? node.commands;
          return {
            canContinue: false,
            canOpenTerminal: commands?.includes(OPENCODE_TERMINAL_RESUME_COMMAND) === true,
          };
        },
        project: (session, capabilities) => ({ ...session, ...capabilities }),
      },
      messages: {
        invalidNodeCursor: "OpenCode node returned an invalid cursor",
        invalidNodeSessionPage: "OpenCode node returned an invalid session page",
        invalidNodeTranscriptPage: "OpenCode node returned an invalid transcript page",
        invalidHostId: "OpenCode session catalog hostId is invalid",
        localReadFailed: "Local OpenCode sessions are unavailable",
        nodeInvokeFailed: "Paired node OpenCode sessions are unavailable",
        nodeReadUnavailable: "paired-node OpenCode session host is unavailable",
        nodeTerminalUnavailable: "paired-node OpenCode terminal is unavailable",
        sessionUnavailable: "OpenCode session is unavailable",
      },
      continuation: {
        resolveAgentId: (agentId) =>
          resolveSessionAgentIdsStrict({ config: api.config, agentId }).sessionAgentId,
        availability: () =>
          resolveAcpSessionAvailability({
            config: currentOpenCodeCatalogConfig(api),
            backendId: ACPX_BACKEND_ID,
            agentId: OPENCODE_ACP_AGENT_ID,
          }),
        listAdopted: (agentId, sessionEntries) => adoption.listAdopted(agentId, sessionEntries),
        loadSession: (threadId) => loadContinuableOpenCodeSession(api, threadId),
        validateSession: () => undefined,
        create: (params) => adoption.create(params),
        complete: (continued, threadId) =>
          linkContinuedOpenCodeSession(continued.sessionKey, threadId),
        nodeReadOnlyMessage: "paired-node OpenCode session rows are view-only",
      },
      terminal: {
        executable: "opencode",
        uploadPathStyle: "native",
        args: (threadId) => ["--session", threadId],
        title: (threadId) => `opencode --session ${threadId.slice(0, 12)}…`,
        requireLocalSession: requireLocalOpenCodeSession,
        unavailableMessage: "OpenCode CLI is unavailable",
      },
      checkUpstreamActivity: (probes, policy) =>
        checkOpenCodeUpstreamActivity(
          probes.filter(
            (probe) =>
              probe.hostId !== LOCAL_HOST_ID ||
              policy?.allowProcessHomeFallback !== false ||
              !openCodeUsesProcessHomeFallback(process.env),
          ),
        ),
    },
    isExactOpenCodeSessionCursor,
  );
  api.registerSessionCatalog({
    id: "opencode",
    label: "OpenCode",
    supportsProcessHomeIsolation: true,
    ...provider,
  });
  const nodeHost = createOpenCodeNodeHostBindings(api);
  for (const command of nodeHost.commands) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of nodeHost.policies) {
    api.registerNodeInvokePolicy(policy);
  }
}
