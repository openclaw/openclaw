import process from "node:process";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogProvider,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  listLocalPiSessionPage,
  optionalPiString,
  readLocalPiTranscriptPage,
  type PiSessionPage,
} from "./pi-session-catalog.js";
import { piSessionStoreAvailable } from "./pi-session-paths.js";

export const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
export const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";

const CAPABILITY = "pi-sessions";
const LOCAL_HOST_ID = "gateway";
const MAX_PAGE_LIMIT = 100;
const MAX_HOSTS = 100;
const MAX_CURSOR_LENGTH = 128;
const NODE_TIMEOUT_MS = 20_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Pi session parameters must be valid JSON", { cause: error });
  }
}

function fullConfigCatalogEnabled(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return true;
  }
  const entry = config.plugins.entries.acpx;
  if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.piSessionCatalog)) {
    return true;
  }
  return entry.config.piSessionCatalog.enabled !== false;
}

export function isPiSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.piSessionCatalog) ||
    pluginConfig.piSessionCatalog.enabled !== false
  );
}

export function createPiSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const available = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && piSessionStoreAvailable(env);
  return [
    {
      command: PI_SESSIONS_LIST_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalPiSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: PI_SESSION_READ_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalPiTranscriptPage(parseNodeParams(paramsJSON))),
    },
  ];
}

export function createPiSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) => context.invokeNode(),
    },
  ];
}

function nodeLabel(node: { displayName?: string; remoteIp?: string; nodeId: string }): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function unwrapNodePayload(value: unknown): unknown {
  return isRecord(value) && typeof value.payloadJSON === "string"
    ? (JSON.parse(value.payloadJSON) as unknown)
    : value;
}

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];

async function listPiNodeHost(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
  node: CatalogNode,
): Promise<SessionCatalogHost> {
  const hostId = `node:${node.nodeId}`;
  const common = {
    hostId,
    label: nodeLabel(node),
    kind: "node" as const,
    connected: node.connected === true,
    nodeId: node.nodeId,
  };
  if (node.connected !== true) {
    return {
      ...common,
      sessions: [],
      error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
    };
  }
  try {
    const raw = await runtime.nodes.invoke({
      nodeId: node.nodeId,
      command: PI_SESSIONS_LIST_COMMAND,
      params: {
        ...(query.limitPerHost ? { limit: query.limitPerHost } : {}),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(query.cursors?.[hostId] ? { cursor: query.cursors[hostId] } : {}),
      },
      timeoutMs: NODE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    return { ...common, ...parseNodeSessionPage(unwrapNodePayload(raw)) };
  } catch {
    return {
      ...common,
      sessions: [],
      error: { code: "NODE_INVOKE_FAILED", message: "Paired node Pi sessions are unavailable" },
    };
  }
}

function parseNodeSessionPage(value: unknown): PiSessionPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Pi node returned an invalid session page");
  }
  const sessions = value.sessions as SessionCatalogSession[];
  if (
    sessions.some((session) => !isRecord(session) || !SESSION_ID_PATTERN.test(session.threadId))
  ) {
    throw new Error("Pi node returned an invalid session page");
  }
  const nextCursor = optionalPiString(value.nextCursor, MAX_CURSOR_LENGTH);
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

function parseNodeTranscriptPage(value: unknown, threadId: string): SessionsCatalogReadResult {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("Pi node returned an invalid transcript page");
  }
  const nextCursor = optionalPiString(value.nextCursor, MAX_CURSOR_LENGTH);
  return {
    hostId: LOCAL_HOST_ID,
    threadId,
    items: value.items as SessionCatalogTranscriptItem[],
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function listPiHosts(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
): Promise<SessionCatalogHost[]> {
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: SessionCatalogHost[] = [];
  if ((!requested || requested.has(LOCAL_HOST_ID)) && piSessionStoreAvailable(process.env)) {
    try {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local Pi",
        kind: "gateway",
        connected: true,
        ...(await listLocalPiSessionPage({
          limit: query.limitPerHost,
          searchTerm: query.search,
          cursor: query.cursors?.[LOCAL_HOST_ID],
        })),
      });
    } catch {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local Pi",
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: "Local Pi sessions are unavailable" },
      });
    }
  }
  let nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"];
  try {
    nodes = (await runtime.nodes.list()).nodes;
  } catch {
    return hosts;
  }
  const eligible = nodes
    .filter(
      (node) =>
        node.commands?.includes(PI_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .slice(0, MAX_HOSTS - hosts.length)
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)));
  const nodeHosts = await Promise.all(eligible.map((node) => listPiNodeHost(runtime, query, node)));
  return [...hosts, ...nodeHosts];
}

async function readPiTranscript(
  runtime: PluginRuntime,
  request: Parameters<SessionCatalogProvider["read"]>[0],
): Promise<SessionsCatalogReadResult> {
  if (request.hostId === LOCAL_HOST_ID) {
    return await readLocalPiTranscriptPage({
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
  }
  if (!request.hostId.startsWith("node:")) {
    throw new Error("hostId is invalid");
  }
  const nodeId = request.hostId.slice("node:".length);
  const node = (await runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(PI_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new Error("paired-node Pi session host is unavailable");
  }
  const raw = await runtime.nodes.invoke({
    nodeId,
    command: PI_SESSION_READ_COMMAND,
    params: {
      threadId: request.threadId,
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
    },
    timeoutMs: NODE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  return {
    ...parseNodeTranscriptPage(unwrapNodePayload(raw), request.threadId),
    hostId: request.hostId,
    label: nodeLabel(node),
  };
}

export function registerPiSessionCatalog(api: OpenClawPluginApi): void {
  if (!isPiSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  api.registerSessionCatalog({
    id: "pi",
    label: "Pi",
    list: async (query) => await listPiHosts(api.runtime, query),
    read: async (request) => await readPiTranscript(api.runtime, request),
  });
  for (const command of createPiSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createPiSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
