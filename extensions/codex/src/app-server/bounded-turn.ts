import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { resolveCodexAppServerAuthProfileOrder } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { readModelListResult } from "./models.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import {
  assertCodexThreadStartResponse,
  assertCodexTurnStartResponse,
  readCodexErrorNotification,
  readCodexTurnCompletedNotification,
} from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexErrorNotification,
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readCodexRateLimitsRevision } from "./rate-limit-cache.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { buildCodexRuntimeThreadConfig } from "./thread-lifecycle.js";
import {
  CodexBoundedTurnUsageLimitError,
  resolveCodexBoundedTurnUsageLimitError,
} from "./usage-limit-error.js";

const CODEX_PRIVATE_STDIO_ARGS = ["app-server", "--listen", "stdio://"];
const OPENCLAW_CODEX_APP_SERVER_ARGS_ENV_VAR = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const CODEX_BOUNDED_THREAD_CONFIG: JsonObject = {
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.standalone_web_search": false,
  web_search: "disabled",
};
const CODEX_PRIVATE_BOUNDED_THREAD_CONFIG: JsonObject = {
  "features.hooks": false,
  notify: [],
};
// Caps how many auth profiles a bounded turn walks after usage-limit failures;
// each attempt spawns its own app-server client.
const CODEX_BOUNDED_TURN_MAX_AUTH_PROFILE_ATTEMPTS = 3;

export type CodexBoundedTurnOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
};

export type CodexBoundedTurnResult = {
  text: string;
  items: CodexThreadItem[];
  model: string;
};

type CodexBoundedTurnModelSelection = { mode: "required"; id: string } | { mode: "live-default" };

type CodexBoundedTurnParams = {
  config?: OpenClawConfig;
  model: CodexBoundedTurnModelSelection;
  profile?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  options: CodexBoundedTurnOptions;
  taskLabel: string;
  developerInstructions: string;
  input: CodexUserInput[];
  requiredModalities: string[];
  isolation: "configured-transport" | "private-stdio";
  threadConfig?: JsonObject;
};

export async function runBoundedCodexAppServerTurn(
  params: CodexBoundedTurnParams,
): Promise<CodexBoundedTurnResult> {
  const appServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.options.pluginConfig,
  });
  const profileAttempts = resolveBoundedTurnAuthProfileAttempts(params, appServer);
  // Rotation attempts share one deadline so usage-limit retries never extend
  // the caller's timeout budget.
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
  const deadlineMs = Date.now() + timeoutMs;
  let lastError: unknown;
  for (let attempt = 0; attempt < profileAttempts.length; attempt += 1) {
    const profile = profileAttempts[attempt];
    const remainingMs = attempt === 0 ? timeoutMs : deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    try {
      return await runBoundedCodexAppServerTurnWithProfile(
        {
          ...params,
          ...(profile === undefined ? {} : { profile }),
          timeoutMs: remainingMs,
        },
        appServer,
      );
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof CodexBoundedTurnUsageLimitError) ||
        attempt === profileAttempts.length - 1
      ) {
        throw error;
      }
      embeddedAgentLog.info("codex bounded turn hit a usage limit; rotating auth profile", {
        taskLabel: params.taskLabel,
        authProfileId: profile,
        nextAuthProfileId: profileAttempts[attempt + 1],
      });
    }
  }
  throw lastError;
}

/**
 * Resolves which auth profiles a bounded turn may try. A pinned profile stays
 * pinned; native Codex auth (user home scope) applies no profiles; otherwise
 * the turn walks the configured failover order so a usage-limited profile does
 * not permanently break bounded turns while other profiles still have quota.
 */
function resolveBoundedTurnAuthProfileAttempts(
  params: CodexBoundedTurnParams,
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
): Array<string | undefined> {
  if (appServer.start.homeScope === "user") {
    return [undefined];
  }
  const pinned = params.profile?.trim();
  if (pinned) {
    return [pinned];
  }
  const order = resolveCodexAppServerAuthProfileOrder({
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir?.trim() || undefined,
    config: params.config,
  }).slice(0, CODEX_BOUNDED_TURN_MAX_AUTH_PROFILE_ATTEMPTS);
  return order.length > 0 ? order : [undefined];
}

async function runBoundedCodexAppServerTurnWithProfile(
  params: CodexBoundedTurnParams,
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
): Promise<CodexBoundedTurnResult> {
  if (params.isolation === "configured-transport") {
    return await runBoundedCodexAppServerTurnInWorkspace(params, appServer, {
      cwd: params.agentDir?.trim() || process.cwd(),
    });
  }
  if (appServer.start.transport !== "stdio") {
    throw new Error("Bounded Codex turns require stdio transport so native tools can be isolated.");
  }
  return await withTempWorkspace(
    {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "codex-bounded-turn-",
    },
    async (workspace) => {
      const codexHome = path.join(workspace.dir, "codex-home");
      const cwd = path.join(workspace.dir, "workspace");
      await Promise.all([
        fs.mkdir(codexHome, { recursive: true }),
        fs.mkdir(cwd, { recursive: true }),
      ]);
      return await runBoundedCodexAppServerTurnInWorkspace(params, appServer, { codexHome, cwd });
    },
  );
}

async function runBoundedCodexAppServerTurnInWorkspace(
  params: CodexBoundedTurnParams,
  appServer: ReturnType<typeof resolveCodexAppServerRuntimeOptions>,
  workspace: { codexHome?: string; cwd: string },
): Promise<CodexBoundedTurnResult> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
  const agentDir = params.agentDir?.trim() || undefined;
  // Hosted search needs a private Codex home and cwd so inherited native tools
  // cannot escape the bounded turn. Media calls retain configured transport
  // compatibility while still using an isolated ephemeral thread.
  const startOptions = workspace.codexHome
    ? buildPrivateCodexAppServerStartOptions(appServer.start, workspace.codexHome)
    : appServer.start;
  const ownsClient = !params.options.clientFactory;
  const client = params.options.clientFactory
    ? await params.options.clientFactory({
        startOptions,
        authProfileId: params.profile,
        agentDir,
        config: params.config,
        timeoutMs,
      })
    : await import("./shared-client.js").then(({ createIsolatedCodexAppServerClient }) =>
        createIsolatedCodexAppServerClient({
          startOptions,
          timeoutMs,
          authProfileId: params.profile,
          agentDir,
          authProfileStore: params.authProfileStore,
          config: params.config,
        }),
      );
  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort(params.signal?.reason ?? "aborted");
  if (params.signal?.aborted) {
    abortFromCaller();
  } else {
    params.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
  timeout.unref?.();

  let resolvedModel: string | undefined;
  let rateLimitsRevisionBeforeTurnStart: number | undefined;
  try {
    const model = await resolveCodexBoundedTurnModel({
      client,
      selection: params.model,
      requiredModalities: params.requiredModalities,
      timeoutMs,
      signal: abortController.signal,
    });
    resolvedModel = model;
    const thread = assertCodexThreadStartResponse(
      await client.request<unknown>(
        "thread/start",
        {
          model,
          modelProvider: "openai",
          cwd: workspace.cwd,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          developerInstructions: params.developerInstructions,
          config: buildCodexRuntimeThreadConfig(resolveBoundedThreadConfig(params, workspace), {
            nativeCodeModeEnabled: false,
          }),
          environments: [],
          dynamicTools: [],
          experimentalRawEvents: true,
          ephemeral: true,
        } satisfies CodexThreadStartParams,
        { timeoutMs, signal: abortController.signal },
      ),
    );
    const collector = createCodexBoundedTurnCollector(thread.thread.id, params.taskLabel);
    const cleanup = client.addNotificationHandler(collector.handleNotification);
    const requestCleanup = client.addRequestHandler(
      createCodexBoundedApprovalHandler(params.taskLabel),
    );
    try {
      rateLimitsRevisionBeforeTurnStart = readCodexRateLimitsRevision(client);
      const turn = assertCodexTurnStartResponse(
        await client.request<unknown>(
          "turn/start",
          {
            threadId: thread.thread.id,
            input: params.input,
            cwd: workspace.cwd,
            approvalPolicy: "on-request",
            model,
            effort: "low",
          } satisfies CodexTurnStartParams,
          { timeoutMs, signal: abortController.signal },
        ),
      );
      return {
        ...(await collector.collect(turn.turn, {
          timeoutMs,
          signal: abortController.signal,
        })),
        model,
      };
    } finally {
      requestCleanup();
      cleanup();
    }
  } catch (error) {
    // Usage-limit failures are resolved while the client is still open so the
    // failing profile's rate limits can be read and the profile marked blocked.
    throw (
      (await resolveCodexBoundedTurnUsageLimitError({
        client,
        error,
        authProfileId: params.profile,
        authProfileStore: params.authProfileStore,
        agentDir,
        config: params.config,
        modelId: resolvedModel,
        rateLimitsRevisionBeforeTurnStart,
        timeoutMs,
        signal: abortController.signal,
      })) ?? error
    );
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
    if (ownsClient) {
      client.close();
    }
  }
}

function resolveBoundedThreadConfig(
  params: CodexBoundedTurnParams,
  workspace: { codexHome?: string },
): JsonObject {
  const boundedConfig =
    mergeCodexThreadConfigs(CODEX_BOUNDED_THREAD_CONFIG, params.threadConfig) ??
    CODEX_BOUNDED_THREAD_CONFIG;
  return workspace.codexHome
    ? (mergeCodexThreadConfigs(boundedConfig, CODEX_PRIVATE_BOUNDED_THREAD_CONFIG) ?? boundedConfig)
    : boundedConfig;
}

function buildPrivateCodexAppServerStartOptions(
  start: ReturnType<typeof resolveCodexAppServerRuntimeOptions>["start"],
  codexHome: string,
): ReturnType<typeof resolveCodexAppServerRuntimeOptions>["start"] {
  const privateEnv = Object.fromEntries(
    Object.entries(start.env ?? {}).filter(
      ([name]) => name.trim().toUpperCase() !== OPENCLAW_CODEX_APP_SERVER_ARGS_ENV_VAR,
    ),
  );
  const clearEnv = (start.clearEnv ?? []).filter((name) => {
    const normalized = name.trim().toUpperCase();
    return normalized !== "CODEX_HOME" && normalized !== OPENCLAW_CODEX_APP_SERVER_ARGS_ENV_VAR;
  });
  return {
    ...start,
    args: [...CODEX_PRIVATE_STDIO_ARGS],
    env: {
      ...privateEnv,
      CODEX_HOME: codexHome,
    },
    clearEnv: [...clearEnv, OPENCLAW_CODEX_APP_SERVER_ARGS_ENV_VAR],
  };
}

function createCodexBoundedApprovalHandler(taskLabel: string) {
  return (request: { method: string }): JsonValue | undefined => {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      return {
        decision: "decline",
        reason: `OpenClaw Codex ${taskLabel} does not grant tool or file approvals.`,
      };
    }
    if (request.method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: "turn" };
    }
    if (request.method.includes("requestApproval")) {
      return {
        decision: "decline",
        reason: `OpenClaw Codex ${taskLabel} does not grant native approvals.`,
      };
    }
    if (request.method === "mcpServer/elicitation/request") {
      return { action: "decline" };
    }
    return undefined;
  };
}

async function resolveCodexBoundedTurnModel(params: {
  client: CodexAppServerClient;
  selection: CodexBoundedTurnModelSelection;
  requiredModalities: string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const result = await params.client.request<unknown>(
    "model/list",
    { limit: null, cursor: null, includeHidden: false },
    { timeoutMs: Math.min(params.timeoutMs, 5_000), signal: params.signal },
  );
  const listed = readModelListResult(result).models;
  if (params.selection.mode === "live-default") {
    const supported = listed.filter((entry) =>
      params.requiredModalities.every((modality) => entry.inputModalities.includes(modality)),
    );
    const selected = supported.find((entry) => entry.isDefault) ?? supported[0];
    if (!selected) {
      throw new Error(
        `Codex app-server has no model supporting ${params.requiredModalities.join(" and ")} input.`,
      );
    }
    return selected.model;
  }

  const model = params.selection.id;
  const match = listed.find((entry) => entry.model === model || entry.id === model);
  if (!match) {
    throw new Error(`Codex app-server model not found: ${model}`);
  }
  if (params.requiredModalities.includes("image") && !match.inputModalities.includes("image")) {
    throw new Error(`Codex app-server model does not support images: ${model}`);
  }
  if (params.requiredModalities.includes("text") && !match.inputModalities.includes("text")) {
    throw new Error(`Codex app-server model does not support text: ${model}`);
  }
  return model;
}

/**
 * Builds a bounded-turn failure that keeps the Codex error payload (for
 * example `codexErrorInfo`) attached in the same `data.error` shape as RPC
 * failures, so usage-limit classification does not depend on message text.
 */
function buildCodexBoundedTurnFailureError(
  error: CodexErrorNotification["error"] | null | undefined,
  fallbackMessage: string,
): Error {
  const failure = new Error(error?.message ?? fallbackMessage);
  if (error) {
    Object.assign(failure, { data: { error } });
  }
  return failure;
}

function createCodexBoundedTurnCollector(threadId: string, taskLabel: string) {
  let turnId: string | undefined;
  let completedTurn: CodexTurn | undefined;
  let promptError: string | undefined;
  let promptErrorDetails: CodexErrorNotification["error"] | undefined;
  const pending: CodexServerNotification[] = [];
  const completedItems = new Map<string, CodexThreadItem>();
  const assistantTextByItem = new Map<string, string>();
  const assistantItemOrder: string[] = [];
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const rememberAssistantText = (itemId: string, text: string) => {
    if (!text) {
      return;
    }
    if (!assistantTextByItem.has(itemId)) {
      assistantItemOrder.push(itemId);
    }
    assistantTextByItem.set(itemId, text);
  };

  const handleNotification = (notification: CodexServerNotification): void => {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || readString(params, "threadId") !== threadId) {
      return;
    }
    if (!turnId) {
      pending.push(notification);
      return;
    }
    const notificationTurnId = readNotificationTurnId(params);
    if (notificationTurnId !== turnId) {
      return;
    }
    if (notification.method === "item/completed") {
      const item = readCodexNotificationItem(notification.params);
      if (item) {
        completedItems.set(item.id, item);
        if (item.type === "agentMessage" && typeof item.text === "string") {
          rememberAssistantText(item.id, item.text);
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const itemId = readString(params, "itemId") ?? readString(params, "id") ?? "assistant";
      const delta = readString(params, "delta") ?? "";
      rememberAssistantText(itemId, `${assistantTextByItem.get(itemId) ?? ""}${delta}`);
      return;
    }
    if (notification.method === "turn/completed") {
      completedTurn =
        readCodexTurnCompletedNotification(notification.params)?.turn ?? completedTurn;
      resolveCompletion?.();
      return;
    }
    if (notification.method === "error") {
      promptErrorDetails = readCodexErrorNotification(notification.params)?.error;
      promptError = promptErrorDetails?.message ?? `codex app-server ${taskLabel} turn failed`;
      resolveCompletion?.();
    }
  };

  return {
    handleNotification,
    async collect(
      startedTurn: CodexTurn,
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<Omit<CodexBoundedTurnResult, "model">> {
      turnId = startedTurn.id;
      if (isTerminalTurn(startedTurn)) {
        completedTurn = startedTurn;
      }
      for (const notification of pending.splice(0)) {
        handleNotification(notification);
      }
      if (!completedTurn && !promptError) {
        await waitForTurnCompletion({
          completion,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          taskLabel,
        });
      }
      if (promptError) {
        throw buildCodexBoundedTurnFailureError(promptErrorDetails, promptError);
      }
      if (completedTurn?.status === "failed") {
        throw buildCodexBoundedTurnFailureError(
          completedTurn.error,
          `codex app-server ${taskLabel} turn failed`,
        );
      }
      const items = collectCompletedItems(completedTurn?.items, completedItems);
      const itemText = collectAssistantTextFromItems(items);
      const deltaText = assistantItemOrder
        .map((itemId) => assistantTextByItem.get(itemId)?.trim())
        .filter((text): text is string => Boolean(text))
        .join("\n\n")
        .trim();
      const text = (itemText || deltaText).trim();
      if (!text) {
        throw new Error(`Codex app-server ${taskLabel} turn returned no text.`);
      }
      return { text, items };
    },
  };
}

function collectCompletedItems(
  turnItems: CodexThreadItem[] | undefined,
  notificationItems: Map<string, CodexThreadItem>,
): CodexThreadItem[] {
  const items = new Map(notificationItems);
  for (const item of turnItems ?? []) {
    items.set(item.id, item);
  }
  return [...items.values()];
}

async function waitForTurnCompletion(params: {
  completion: Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
  taskLabel: string;
}): Promise<void> {
  if (params.signal.aborted) {
    throw new Error(`codex app-server ${params.taskLabel} turn aborted`);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbort: (() => void) | undefined;
  try {
    await Promise.race([
      params.completion,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`codex app-server ${params.taskLabel} turn timed out`)),
          params.timeoutMs,
        );
        timeout.unref?.();
        const abortListener = () =>
          reject(new Error(`codex app-server ${params.taskLabel} turn aborted`));
        params.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => params.signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    cleanupAbort?.();
  }
}

function collectAssistantTextFromItems(items: CodexThreadItem[] | undefined): string {
  return (items ?? [])
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function readNotificationTurnId(record: JsonObject): string | undefined {
  const direct = readString(record, "turnId");
  if (direct) {
    return direct;
  }
  return isJsonObject(record.turn) ? readString(record.turn, "id") : undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isTerminalTurn(turn: CodexTurn): boolean {
  return turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed";
}
