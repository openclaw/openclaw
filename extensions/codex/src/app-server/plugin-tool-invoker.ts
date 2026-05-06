import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  type CodexAppServerClientFactory,
  defaultCodexAppServerClientFactory,
} from "./client-factory.js";
import { type CodexAppServerClient, isCodexAppServerConnectionClosedError } from "./client.js";
import {
  readCodexPluginConfig,
  resolveCodexPluginsConfig,
  resolveCodexAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "./config.js";
import { ensureCodexPluginActivated, refreshCodexPluginRuntimeState } from "./plugin-activation.js";
import {
  buildCodexPluginMention,
  readCodexPluginInventory,
  resolveCodexPluginEffectivePolicy,
  type CodexPluginInventoryRecord,
} from "./plugin-inventory.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

const CODEX_PLUGIN_TOOL_TIMEOUT_MS = 5 * 60_000;
const CODEX_PLUGIN_TURN_IDLE_TIMEOUT_MS = 30_000;
const CODEX_PLUGIN_DEVELOPER_INSTRUCTIONS = [
  "You are running inside OpenClaw as a bridge to one Codex plugin.",
  "Use only the mentioned plugin when it is relevant to the user request.",
  "Return a concise answer with the observable plugin result. Do not describe unsupported UI actions as completed.",
].join("\n\n");

export type CodexPluginToolInvocationResult = {
  text: string;
  threadId: string;
  turnId: string;
  status: string;
  activationStatus: string;
  appIdsEnabled: string[];
};

export async function invokeCodexPluginTool(params: {
  pluginConfig: CodexPluginConfig;
  record: CodexPluginInventoryRecord;
  request: string;
  context?: OpenClawPluginToolContext;
  clientFactory?: CodexAppServerClientFactory;
  timeoutMs?: number;
}): Promise<CodexPluginToolInvocationResult> {
  const runtimePluginConfig = readCodexPluginConfig(params.pluginConfig);
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: runtimePluginConfig });
  const agentDir = params.context?.agentDir;
  const config =
    params.context?.getRuntimeConfig?.() ?? params.context?.runtimeConfig ?? params.context?.config;
  const clientFactory = params.clientFactory ?? defaultCodexAppServerClientFactory;
  const client = await clientFactory(appServer.start, undefined, agentDir, config);
  const request = makeRequest(client, appServer.requestTimeoutMs);

  const inventory = await readCodexPluginInventory({
    pluginConfig: runtimePluginConfig,
    request,
    forceRefetchApps: true,
  });
  const record =
    inventory.records.find((candidate) => candidate.key === params.record.key) ?? params.record;
  const activation = await ensureCodexPluginActivated({ request, record });
  if (activation.status !== "ready") {
    throw new Error(formatActivationFailure(record, activation.status));
  }

  const appIdsEnabled = await enableCodexPluginAppsBestEffort({ request, record });
  const thread = await request<{ thread: { id: string } }>("thread/start", {
    model: resolveCodexPluginToolModel(config),
    cwd: params.context?.workspaceDir ?? process.cwd(),
    approvalPolicy: appServer.approvalPolicy,
    approvalsReviewer: appServer.approvalsReviewer,
    sandbox: appServer.sandbox,
    ...(appServer.serviceTier ? { serviceTier: appServer.serviceTier } : {}),
    serviceName: "OpenClaw",
    developerInstructions: CODEX_PLUGIN_DEVELOPER_INSTRUCTIONS,
    ephemeral: true,
    experimentalRawEvents: true,
    persistExtendedHistory: true,
  });

  const threadId = thread.thread.id;
  const run = await runCodexPluginTurn({
    client,
    request,
    threadId,
    plugin: record,
    userRequest: params.request,
    context: params.context,
    pluginConfig: runtimePluginConfig,
    timeoutMs: params.timeoutMs ?? CODEX_PLUGIN_TOOL_TIMEOUT_MS,
    cwd: params.context?.workspaceDir ?? process.cwd(),
  });

  return {
    ...run,
    threadId,
    activationStatus: activation.status,
    appIdsEnabled,
  };
}

function makeRequest(client: CodexAppServerClient, timeoutMs: number) {
  return <M extends string>(method: M, requestParams?: unknown) =>
    client.request(method, requestParams, { timeoutMs });
}

async function enableCodexPluginAppsBestEffort(params: {
  request: <T = JsonValue | undefined>(method: string, requestParams?: unknown) => Promise<T>;
  record: CodexPluginInventoryRecord;
}): Promise<string[]> {
  const apps = await params.request<{
    data?: Array<{ id?: string; pluginDisplayNames?: string[] }>;
  }>("app/list", { forceRefetch: true });
  const displayNames = new Set([
    params.record.displayName,
    params.record.pluginName,
    params.record.pluginId,
  ]);
  const appIds = (apps.data ?? [])
    .filter((app) => app.id && app.pluginDisplayNames?.some((name) => displayNames.has(name)))
    .map((app) => app.id)
    .filter((id): id is string => Boolean(id));
  if (appIds.length === 0) {
    return [];
  }
  await params.request("config/batchWrite", {
    edits: appIds.map((id) => ({
      keyPath: `apps.${id}.enabled`,
      value: true,
      mergeStrategy: "upsert",
    })),
    reloadUserConfig: true,
  });
  await refreshCodexPluginRuntimeState(params.request);
  return appIds;
}

async function runCodexPluginTurn(params: {
  client: CodexAppServerClient;
  request: <T = JsonValue | undefined>(method: string, requestParams?: unknown) => Promise<T>;
  threadId: string;
  plugin: CodexPluginInventoryRecord;
  userRequest: string;
  context?: OpenClawPluginToolContext;
  pluginConfig: CodexPluginConfig;
  timeoutMs: number;
  cwd: string;
}): Promise<Pick<CodexPluginToolInvocationResult, "text" | "turnId" | "status">> {
  let turnId: string | undefined;
  const assistantTextByItem = new Map<string, string>();
  let completed = false;
  let terminalStatus = "unknown";
  let terminalError: string | undefined;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const timeout = setTimeout(
    () => {
      rejectCompletion?.(new Error("Codex plugin turn timed out"));
    },
    Math.max(100, params.timeoutMs),
  );
  timeout.unref?.();
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;

  const notificationCleanup = params.client.addNotificationHandler((notification) => {
    handleCodexPluginNotification({
      notification,
      threadId: params.threadId,
      turnId,
      assistantTextByItem,
      onCompleted(status, error) {
        completed = true;
        terminalStatus = status;
        terminalError = error;
        resolveCompletion?.();
      },
    });
  });
  const requestCleanup = params.client.addRequestHandler((request) => {
    if (!turnId || !requestMatchesTurn(request.params, params.threadId, turnId)) {
      return undefined;
    }
    if (request.method === "mcpServer/elicitation/request") {
      return buildCodexPluginElicitationResponse(
        params.pluginConfig,
        params.plugin,
        request.params,
      );
    }
    return undefined;
  });

  try {
    const response = await params.request<{
      turn: { id: string; status: string; error?: unknown };
    }>("turn/start", {
      threadId: params.threadId,
      input: [
        {
          type: "text",
          text: `${buildCodexPluginMention(params.plugin)}\n\n${params.userRequest}`,
          text_elements: [],
        },
      ],
      cwd: params.cwd,
    });
    turnId = response.turn.id;
    idleTimeout = setTimeout(() => {
      if (!completed) {
        rejectCompletion?.(new Error("Codex plugin turn idle timed out waiting for completion"));
      }
    }, CODEX_PLUGIN_TURN_IDLE_TIMEOUT_MS);
    idleTimeout.unref?.();
    if (response.turn.status !== "inProgress") {
      completed = true;
      terminalStatus = response.turn.status;
    }
    if (!completed) {
      await completion;
    }
  } catch (error) {
    if (isCodexAppServerConnectionClosedError(error)) {
      throw new Error("Codex app-server closed while running plugin tool", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    notificationCleanup();
    requestCleanup();
  }

  const text = [...assistantTextByItem.values()].join("\n\n").trim();
  if (terminalStatus === "failed") {
    throw new Error(terminalError ?? "Codex plugin turn failed");
  }
  return {
    text: text || `Codex plugin turn finished with status ${terminalStatus}.`,
    turnId: turnId ?? "",
    status: terminalStatus,
  };
}

function handleCodexPluginNotification(params: {
  notification: CodexServerNotification;
  threadId: string;
  turnId: string | undefined;
  assistantTextByItem: Map<string, string>;
  onCompleted: (status: string, error?: string) => void;
}): void {
  const notificationParams = isJsonObject(params.notification.params)
    ? params.notification.params
    : undefined;
  if (!notificationParams || notificationParams.threadId !== params.threadId) {
    return;
  }
  if (
    params.notification.method === "item/agentMessage/delta" &&
    params.turnId &&
    notificationParams.turnId === params.turnId
  ) {
    const itemId = typeof notificationParams.itemId === "string" ? notificationParams.itemId : "";
    const delta = typeof notificationParams.delta === "string" ? notificationParams.delta : "";
    if (itemId && delta) {
      params.assistantTextByItem.set(
        itemId,
        `${params.assistantTextByItem.get(itemId) ?? ""}${delta}`,
      );
    }
    return;
  }
  if (
    params.notification.method === "item/completed" &&
    params.turnId &&
    notificationParams.turnId === params.turnId &&
    isJsonObject(notificationParams.item) &&
    notificationParams.item.type === "agentMessage"
  ) {
    const item = notificationParams.item;
    if (typeof item.id === "string" && typeof item.text === "string") {
      params.assistantTextByItem.set(item.id, item.text);
    }
    return;
  }
  if (params.notification.method !== "turn/completed") {
    return;
  }
  if (!isJsonObject(notificationParams.turn)) {
    return;
  }
  const turn = notificationParams.turn;
  if (params.turnId && turn.id !== params.turnId) {
    return;
  }
  const status = typeof turn.status === "string" ? turn.status : "completed";
  const error = isJsonObject(turn.error)
    ? (readString(turn.error, "message") ?? readString(turn.error, "details"))
    : undefined;
  params.onCompleted(status, error);
}

function buildCodexPluginElicitationResponse(
  pluginConfig: CodexPluginConfig,
  record: CodexPluginInventoryRecord,
  requestParams?: JsonValue,
): JsonValue {
  const policy = resolveCodexPluginEffectivePolicy({
    config: resolveCodexPluginsConfig({ pluginConfig }),
    entry: record.configEntry,
  });
  if (!policy.allowDestructiveActions) {
    return { action: "decline", content: null, _meta: null };
  }
  return {
    action: "accept",
    content: buildAcceptContent(requestParams),
    _meta: null,
  };
}

function buildAcceptContent(requestParams: JsonValue | undefined): JsonValue {
  if (!isJsonObject(requestParams) || !isJsonObject(requestParams.requestedSchema)) {
    return null;
  }
  const schema = requestParams.requestedSchema;
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const content: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = isJsonObject(value) ? value : undefined;
    if (!property) {
      continue;
    }
    const text = [key, readString(property, "title"), readString(property, "description")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (readString(property, "type") === "boolean" && /\b(approve|allow|accept)\b/.test(text)) {
      content[key] = true;
    }
  }
  return Object.keys(content).length > 0 ? content : null;
}

function requestMatchesTurn(
  value: JsonValue | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  return readString(value, "threadId") === threadId && readString(value, "turnId") === turnId;
}

function resolveCodexPluginToolModel(config: OpenClawConfig | undefined): string {
  const rawModel = config?.agents?.defaults?.model;
  const primary = typeof rawModel === "string" ? rawModel : rawModel?.primary;
  const model = primary?.includes("/") ? primary.split("/").at(-1) : primary;
  return model || "gpt-5.5";
}

function formatActivationFailure(record: CodexPluginInventoryRecord, status: string): string {
  if (status === "auth_required") {
    return `${record.displayName} needs app authorization in Codex before OpenClaw can use it.`;
  }
  if (status === "not_migrated") {
    return `${record.displayName} was not observed as an installed source Codex plugin during migration.`;
  }
  if (status === "disabled") {
    return `${record.displayName} is disabled in OpenClaw codexPlugins config.`;
  }
  return `Codex plugin ${record.displayName} is not ready: ${status}.`;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
