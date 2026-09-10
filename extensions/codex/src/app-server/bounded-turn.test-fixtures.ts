import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { vi } from "vitest";
import {
  createFakeCodexAppServerClient,
  threadStartResult as createThreadStartResult,
  turnStartResult,
} from "./codex-app-server.test-fixtures.js";
import type { JsonValue } from "./protocol.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

export function codexModel(model = "gpt-5.4", id = model) {
  return {
    id,
    model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "test model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

export function threadStartResult(model: string, modelProvider = "openai") {
  const result = createThreadStartResult("thread-finalizer", "/tmp/finalizer");
  return {
    ...result,
    thread: { ...result.thread, sessionId: "session-finalizer", ephemeral: true, modelProvider },
    model,
    modelProvider,
    approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

export function completedTurnResult() {
  return {
    turn: {
      ...turnStartResult("turn-finalizer", "completed").turn,
      items: [{ id: "answer", type: "agentMessage", text: "The message was sent successfully." }],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    },
  };
}

export function inProgressTurnResult() {
  return { turn: { ...turnStartResult("turn-finalizer").turn, startedAt: 1 } };
}

export function createClientFactory(
  options: {
    mcpServers?: unknown[];
    errorBeforeCompletion?: { message: string; willRetry: boolean };
    terminalStatus?: "completed" | "interrupted";
    assistantDelta?: string;
    emptyAnswer?: boolean;
    completeTurn?: boolean;
    models?: ReturnType<typeof codexModel>[];
    beforeRequest?: (method: string) => Promise<void>;
    modelProvider?: string;
    responseCompletions?: Array<{ responseId: string; usage: JsonValue }>;
    preBindDeltaCount?: number;
  } = {},
) {
  const methods: string[] = [];
  const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
    methods.push(method);
    if (options.beforeRequest) {
      await options.beforeRequest(method);
    }
    if (method === "model/list") {
      const includeHidden = isRecord(params) && params.includeHidden === true;
      return {
        data: (options.models ?? [codexModel()]).filter((model) => includeHidden || !model.hidden),
        nextCursor: null,
      };
    }
    if (method === "config/read") {
      return {
        config: { mcp_servers: { inherited: { command: "unsafe" } } },
        layers: [{ name: { type: "user" } }],
      };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start" && isRecord(params) && typeof params.model === "string") {
      return threadStartResult(params.model, options.modelProvider);
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: options.mcpServers ?? [
          {
            name: "inherited",
            serverInfo: null,
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "unsupported",
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        for (const handler of fixture.notifications) {
          void handler({
            method: "turn/completed",
            params: {
              threadId: "thread-finalizer",
              turn: { ...inProgressTurnResult().turn, status: "interrupted" },
            },
          });
        }
      });
      return {};
    }
    if (method === "turn/start") {
      if (options.completeTurn === false) {
        return inProgressTurnResult();
      }
      queueMicrotask(() => {
        for (const handler of fixture.notifications) {
          for (let index = 0; index < (options.preBindDeltaCount ?? 0); index += 1) {
            void handler({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                itemId: "answer",
                delta: ".",
              },
            });
          }
          if (options.errorBeforeCompletion) {
            void handler({
              method: "error",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                error: { message: options.errorBeforeCompletion.message },
                willRetry: options.errorBeforeCompletion.willRetry,
              },
            });
          }
          if (options.assistantDelta) {
            void handler({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                itemId: "answer",
                delta: options.assistantDelta,
              },
            });
          }
          for (const response of options.responseCompletions ?? [
            {
              responseId: "response-finalizer",
              usage: {
                totalTokens: 12,
                inputTokens: 8,
                cachedInputTokens: 2,
                cacheWriteInputTokens: 1,
                outputTokens: 4,
                reasoningOutputTokens: 3,
              },
            },
          ]) {
            void handler({
              method: "rawResponse/completed",
              params: {
                threadId: "thread-finalizer",
                turnId: "turn-finalizer",
                ...response,
              },
            });
          }
          void handler({
            method: "turn/completed",
            params: {
              threadId: "thread-finalizer",
              turnId: "turn-finalizer",
              turn: {
                ...completedTurnResult().turn,
                status: options.terminalStatus ?? "completed",
                ...(options.terminalStatus === "interrupted" || options.emptyAnswer
                  ? { items: [] }
                  : {}),
              },
            },
          });
        }
      });
      return inProgressTurnResult();
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const request = fixture.request;
  const client = Object.assign(fixture.client, { close: vi.fn() });
  const factory = vi.fn(async () => client) as unknown as CodexAppServerClientFactory;
  return {
    factory,
    methods,
    request,
    notifications: fixture.notifications,
    requests: fixture.requests,
    handleServerRequest: (serverRequest: Parameters<typeof fixture.handleServerRequest>[0]) =>
      fixture.handleServerRequest(serverRequest),
    notify: (notification: Parameters<typeof fixture.notify>[0]) => fixture.notify(notification),
    close: fixture.close,
  };
}
