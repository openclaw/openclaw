import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import type { CodexAppServerClientFactory } from "./client-factory.js";
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
  type CodexServerNotification,
  type CodexThreadItem,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams,
  type CodexUserInput,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { buildCodexRuntimeThreadConfig } from "./thread-lifecycle.js";

const CODEX_BOUNDED_THREAD_CONFIG: JsonObject = {
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.standalone_web_search": false,
  web_search: "disabled",
};

export type CodexBoundedTurnOptions = {
  pluginConfig?: unknown;
  clientFactory?: CodexAppServerClientFactory;
};

export type CodexBoundedTurnResult = {
  text: string;
  items: CodexThreadItem[];
};

export async function runBoundedCodexAppServerTurn(params: {
  config?: OpenClawConfig;
  model: string;
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
  threadConfig?: JsonObject;
}): Promise<CodexBoundedTurnResult> {
  const appServer = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.options.pluginConfig,
  });
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 100, 100);
  const agentDir = params.agentDir?.trim() || undefined;
  const cwd = agentDir ?? process.cwd();
  const ownsClient = !params.options.clientFactory;
  const client = params.options.clientFactory
    ? await params.options.clientFactory(appServer.start, params.profile, agentDir, params.config, {
        timeoutMs,
      })
    : await import("./shared-client.js").then(({ createIsolatedCodexAppServerClient }) =>
        createIsolatedCodexAppServerClient({
          startOptions: appServer.start,
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

  try {
    await assertCodexModelSupportsInput({
      client,
      model: params.model,
      requiredModalities: params.requiredModalities,
      timeoutMs,
      signal: abortController.signal,
    });
    const thread = assertCodexThreadStartResponse(
      await client.request<unknown>(
        "thread/start",
        {
          model: params.model,
          modelProvider: "openai",
          cwd,
          approvalPolicy: "on-request",
          sandbox: "read-only",
          serviceName: "OpenClaw",
          developerInstructions: params.developerInstructions,
          config: buildCodexRuntimeThreadConfig(
            mergeCodexThreadConfigs(CODEX_BOUNDED_THREAD_CONFIG, params.threadConfig),
            { nativeCodeModeEnabled: false },
          ),
          environments: [],
          dynamicTools: [],
          experimentalRawEvents: true,
          persistExtendedHistory: false,
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
      const turn = assertCodexTurnStartResponse(
        await client.request<unknown>(
          "turn/start",
          {
            threadId: thread.thread.id,
            input: params.input,
            cwd,
            approvalPolicy: "on-request",
            model: params.model,
            effort: "low",
          } satisfies CodexTurnStartParams,
          { timeoutMs, signal: abortController.signal },
        ),
      );
      return await collector.collect(turn.turn, {
        timeoutMs,
        signal: abortController.signal,
      });
    } finally {
      requestCleanup();
      cleanup();
    }
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abortFromCaller);
    if (ownsClient) {
      client.close();
    }
  }
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

async function assertCodexModelSupportsInput(params: {
  client: CodexAppServerClient;
  model: string;
  requiredModalities: string[];
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const result = await params.client.request<unknown>(
    "model/list",
    { limit: 100, cursor: null, includeHidden: false },
    { timeoutMs: Math.min(params.timeoutMs, 5_000), signal: params.signal },
  );
  const listed = readModelListResult(result).models;
  const match = listed.find((entry) => entry.model === params.model || entry.id === params.model);
  if (!match) {
    throw new Error(`Codex app-server model not found: ${params.model}`);
  }
  if (params.requiredModalities.includes("image") && !match.inputModalities.includes("image")) {
    throw new Error(`Codex app-server model does not support images: ${params.model}`);
  }
  if (params.requiredModalities.includes("text") && !match.inputModalities.includes("text")) {
    throw new Error(`Codex app-server model does not support text: ${params.model}`);
  }
}

function createCodexBoundedTurnCollector(threadId: string, taskLabel: string) {
  let turnId: string | undefined;
  let completedTurn: CodexTurn | undefined;
  let promptError: string | undefined;
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
      promptError =
        readCodexErrorNotification(notification.params)?.error.message ??
        `codex app-server ${taskLabel} turn failed`;
      resolveCompletion?.();
    }
  };

  return {
    handleNotification,
    async collect(
      startedTurn: CodexTurn,
      options: { timeoutMs: number; signal: AbortSignal },
    ): Promise<CodexBoundedTurnResult> {
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
        throw new Error(promptError);
      }
      if (completedTurn?.status === "failed") {
        throw new Error(
          completedTurn.error?.message ?? `codex app-server ${taskLabel} turn failed`,
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
