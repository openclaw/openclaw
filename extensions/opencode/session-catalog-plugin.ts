import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
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
  listLocalOpenCodeSessionPage,
  optionalOpenCodeString,
  readLocalOpenCodeTranscriptPage,
  type OpenCodeSessionPage,
} from "./session-catalog.js";

export const OPENCODE_SESSIONS_LIST_COMMAND = "opencode.sessions.list.v1";
export const OPENCODE_SESSION_READ_COMMAND = "opencode.sessions.read.v1";

const CAPABILITY = "opencode-sessions";
const LOCAL_HOST_ID = "gateway";
const MAX_PAGE_LIMIT = 100;
const MAX_HOSTS = 100;
const MAX_CURSOR_LENGTH = 128;
const NODE_TIMEOUT_MS = 35_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

function executableOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      if (!directory.trim()) {
        continue;
      }
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) {
          continue;
        }
        if (process.platform !== "win32") {
          accessSync(candidate, constants.X_OK);
        }
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

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

export function isOpenCodeSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.sessionCatalog) ||
    pluginConfig.sessionCatalog.enabled !== false
  );
}

export function createOpenCodeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const available = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && executableOnPath("opencode", env);
  return [
    {
      command: OPENCODE_SESSIONS_LIST_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalOpenCodeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: OPENCODE_SESSION_READ_COMMAND,
      cap: CAPABILITY,
      dangerous: false,
      isAvailable: available,
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalOpenCodeTranscriptPage(parseNodeParams(paramsJSON))),
    },
  ];
}

export function createOpenCodeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [OPENCODE_SESSIONS_LIST_COMMAND, OPENCODE_SESSION_READ_COMMAND],
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

async function listOpenCodeNodeHost(
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
      command: OPENCODE_SESSIONS_LIST_COMMAND,
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
      error: {
        code: "NODE_INVOKE_FAILED",
        message: "Paired node OpenCode sessions are unavailable",
      },
    };
  }
}

function parseNodeSessionPage(value: unknown): OpenCodeSessionPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("OpenCode node returned an invalid session page");
  }
  const sessions = value.sessions as SessionCatalogSession[];
  if (
    sessions.some((session) => !isRecord(session) || !SESSION_ID_PATTERN.test(session.threadId))
  ) {
    throw new Error("OpenCode node returned an invalid session page");
  }
  const nextCursor = optionalOpenCodeString(value.nextCursor, MAX_CURSOR_LENGTH);
  if (value.nextCursor !== undefined && !nextCursor) {
    throw new Error("OpenCode node returned an invalid cursor");
  }
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

function parseNodeTranscriptPage(value: unknown, threadId: string): SessionsCatalogReadResult {
  if (
    !isRecord(value) ||
    value.threadId !== threadId ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PAGE_LIMIT
  ) {
    throw new Error("OpenCode node returned an invalid transcript page");
  }
  const nextCursor = optionalOpenCodeString(value.nextCursor, MAX_CURSOR_LENGTH);
  return {
    hostId: LOCAL_HOST_ID,
    threadId,
    items: value.items as SessionCatalogTranscriptItem[],
    ...(nextCursor ? { nextCursor } : {}),
  };
}

async function listOpenCodeHosts(
  runtime: PluginRuntime,
  query: Parameters<SessionCatalogProvider["list"]>[0],
): Promise<SessionCatalogHost[]> {
  const requested = query.hostIds ? new Set(query.hostIds) : undefined;
  const hosts: SessionCatalogHost[] = [];
  if ((!requested || requested.has(LOCAL_HOST_ID)) && executableOnPath("opencode", process.env)) {
    try {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local OpenCode",
        kind: "gateway",
        connected: true,
        ...(await listLocalOpenCodeSessionPage({
          limit: query.limitPerHost,
          searchTerm: query.search,
          cursor: query.cursors?.[LOCAL_HOST_ID],
        })),
      });
    } catch {
      hosts.push({
        hostId: LOCAL_HOST_ID,
        label: "Local OpenCode",
        kind: "gateway",
        connected: true,
        sessions: [],
        error: { code: "LOCAL_READ_FAILED", message: "Local OpenCode sessions are unavailable" },
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
        node.commands?.includes(OPENCODE_SESSIONS_LIST_COMMAND) &&
        (!requested || requested.has(`node:${node.nodeId}`)),
    )
    .slice(0, MAX_HOSTS - hosts.length)
    .toSorted((left, right) => nodeLabel(left).localeCompare(nodeLabel(right)));
  const nodeHosts = await Promise.all(
    eligible.map((node) => listOpenCodeNodeHost(runtime, query, node)),
  );
  return [...hosts, ...nodeHosts];
}

async function readOpenCodeTranscript(
  runtime: PluginRuntime,
  request: Parameters<SessionCatalogProvider["read"]>[0],
): Promise<SessionsCatalogReadResult> {
  if (request.hostId === LOCAL_HOST_ID) {
    return await readLocalOpenCodeTranscriptPage({
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
      candidate.commands?.includes(OPENCODE_SESSION_READ_COMMAND),
  );
  if (!node) {
    throw new Error("paired-node OpenCode session host is unavailable");
  }
  const raw = await runtime.nodes.invoke({
    nodeId,
    command: OPENCODE_SESSION_READ_COMMAND,
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

export function registerOpenCodeSessionCatalog(api: OpenClawPluginApi): void {
  if (!isOpenCodeSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  api.registerSessionCatalog({
    id: "opencode",
    label: "OpenCode",
    list: async (query) => await listOpenCodeHosts(api.runtime, query),
    read: async (request) => await readOpenCodeTranscript(api.runtime, request),
  });
  for (const command of createOpenCodeSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createOpenCodeSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}
