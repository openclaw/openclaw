import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import { buildD0RunTraceparent } from "../../../src/infra/d0-traceparent.js";

const D0_RUN_OBSERVABILITY_TIMEOUT_MS = 1500;

type D0PromptSnapshot = {
  input: string;
  triggerSource?: string;
};

type D0ToolStartState = {
  toolName?: string;
  startedAt?: string;
  input?: unknown;
};

type D0RunState = {
  sessionKey?: string;
  startedAt?: string;
  firstResponseSent: boolean;
  assistantText?: string;
  toolStarts: Map<string, D0ToolStartState>;
};

export type D0RunObservabilityState = {
  recordPrompt: (sessionKey: string, input: string, triggerSource?: string) => void;
  consumePrompt: (sessionKey?: string) => D0PromptSnapshot | undefined;
  getRun: (runId: string) => D0RunState | undefined;
  upsertRun: (runId: string, next: Partial<D0RunState>) => D0RunState;
  clearRun: (runId: string) => void;
};

type CreateD0RunObservabilityServiceParams = {
  runtime: PluginRuntime;
  state: D0RunObservabilityState;
  fetchImpl?: typeof fetch;
};

type AgentEventLike = {
  runId: string;
  sessionKey?: string;
  ts?: number;
  stream?: string;
  data?: Record<string, unknown>;
};

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toIsoTimestamp(value: unknown, fallbackMs?: number): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof fallbackMs === "number" && Number.isFinite(fallbackMs)) {
    return new Date(fallbackMs).toISOString();
  }
  return undefined;
}

function resolveApiUrl(ctx: OpenClawPluginServiceContext): string | undefined {
  const raw = (ctx.config as { env?: { DWS_API_URL?: string } }).env?.DWS_API_URL;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.replace(/\/+$/, "") : undefined;
}

function resolveGatewayToken(ctx: OpenClawPluginServiceContext): string | undefined {
  const raw = (ctx.config as { gateway?: { auth?: { token?: string } } }).gateway?.auth?.token;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function createD0RunObservabilityState(): D0RunObservabilityState {
  const promptsBySession = new Map<string, D0PromptSnapshot>();
  const runsById = new Map<string, D0RunState>();

  return {
    recordPrompt(sessionKey: string, input: string, triggerSource?: string) {
      if (!sessionKey.trim() || !input.trim()) {
        return;
      }
      promptsBySession.set(sessionKey, {
        input,
        ...(triggerSource ? { triggerSource } : {}),
      });
    },
    consumePrompt(sessionKey?: string) {
      if (!sessionKey) {
        return undefined;
      }
      const prompt = promptsBySession.get(sessionKey);
      promptsBySession.delete(sessionKey);
      return prompt;
    },
    getRun(runId: string) {
      return runsById.get(runId);
    },
    upsertRun(runId: string, next: Partial<D0RunState>) {
      const existing =
        runsById.get(runId) ??
        ({
          firstResponseSent: false,
          toolStarts: new Map<string, D0ToolStartState>(),
        } satisfies D0RunState);
      const updated: D0RunState = {
        ...existing,
        ...next,
        toolStarts: existing.toolStarts,
      };
      runsById.set(runId, updated);
      return updated;
    },
    clearRun(runId: string) {
      runsById.delete(runId);
    },
  };
}

export function createD0RunObservabilityService(
  params: CreateD0RunObservabilityServiceParams,
): OpenClawPluginService {
  const fetchImpl = params.fetchImpl ?? fetch;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "d0-run-observability",
    async start(ctx) {
      const apiUrl = resolveApiUrl(ctx);
      const gatewayToken = resolveGatewayToken(ctx);

      if (!apiUrl || !gatewayToken) {
        ctx.logger.warn("d0-observability: missing DWS_API_URL or gateway auth token");
        return;
      }

      const postEvent = async (runId: string, body: Record<string, unknown>) => {
        try {
          const response = await fetchImpl(`${apiUrl}/v1/backend/d0/run-observability`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${gatewayToken}`,
              "Content-Type": "application/json",
              traceparent: buildD0RunTraceparent(runId),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(D0_RUN_OBSERVABILITY_TIMEOUT_MS),
          });
          if (!response.ok) {
            ctx.logger.warn(
              `d0-observability: backend rejected run event ${String(
                (body.eventType as string | undefined) ?? "unknown",
              )} with status ${response.status}`,
            );
          }
        } catch (error) {
          ctx.logger.warn(
            `d0-observability: failed to post run event ${String(
              (body.eventType as string | undefined) ?? "unknown",
            )}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      unsubscribe = params.runtime.events.onAgentEvent((rawEvent) => {
        const event = rawEvent as AgentEventLike;
        const sessionKey = asNonEmptyString(event.sessionKey);
        const runId = asNonEmptyString(event.runId);
        if (!runId) {
          return;
        }

        if (event.stream === "lifecycle") {
          const phase = asNonEmptyString(event.data?.phase);
          if (phase === "start") {
            const prompt = params.state.consumePrompt(sessionKey);
            const startedAt = toIsoTimestamp(event.data?.startedAt, event.ts);
            params.state.upsertRun(runId, {
              sessionKey,
              startedAt,
            });
            void postEvent(runId, {
              eventType: "run_started",
              runId,
              ...(sessionKey ? { sessionKey } : {}),
              ...(prompt?.input ? { input: prompt.input } : {}),
              ...(prompt?.triggerSource ? { triggerSource: prompt.triggerSource } : {}),
              ...(startedAt ? { startedAt } : {}),
            });
            return;
          }

          if (phase === "end" || phase === "error") {
            const run = params.state.getRun(runId);
            const endedAt = toIsoTimestamp(event.data?.endedAt, event.ts);
            const error = asNonEmptyString(event.data?.error);
            void postEvent(runId, {
              eventType: "run_finished",
              runId,
              ...(sessionKey ? { sessionKey } : {}),
              ...(run?.assistantText ? { finalOutput: run.assistantText } : {}),
              success: phase === "end" && !error,
              ...(error ? { error } : {}),
              ...(endedAt ? { endedAt } : {}),
            });
            params.state.clearRun(runId);
            return;
          }
        }

        if (event.stream === "assistant") {
          const run = params.state.upsertRun(runId, {
            sessionKey,
          });
          const text = asNonEmptyString(event.data?.text);
          if (text) {
            run.assistantText = text;
          }

          if (!run.firstResponseSent && (asNonEmptyString(event.data?.delta) || text)) {
            run.firstResponseSent = true;
            void postEvent(runId, {
              eventType: "first_response",
              runId,
              ...(sessionKey ? { sessionKey } : {}),
              ...(run.startedAt ? { startedAt: run.startedAt } : {}),
              ...(toIsoTimestamp(event.ts, event.ts)
                ? { firstResponseAt: toIsoTimestamp(event.ts, event.ts) }
                : {}),
            });
          }
          return;
        }

        if (event.stream === "tool") {
          const phase = asNonEmptyString(event.data?.phase);
          const toolCallId = asNonEmptyString(event.data?.toolCallId);
          const run = params.state.upsertRun(runId, {
            sessionKey,
          });

          if (phase === "start" && toolCallId) {
            run.toolStarts.set(toolCallId, {
              toolName: asNonEmptyString(event.data?.name),
              startedAt: toIsoTimestamp(event.ts, event.ts),
              input: event.data?.args,
            });
            return;
          }

          if (phase === "update" && toolCallId) {
            void postEvent(runId, {
              eventType: "tool_update",
              runId,
              ...(sessionKey ? { sessionKey } : {}),
              ...(toolCallId ? { toolCallId } : {}),
              ...(asNonEmptyString(event.data?.name)
                ? { toolName: asNonEmptyString(event.data?.name) }
                : {}),
              ...(event.data?.partialResult !== undefined
                ? { partialResult: event.data.partialResult }
                : {}),
            });
            return;
          }

          if (phase === "result" && toolCallId) {
            const start = run.toolStarts.get(toolCallId);
            run.toolStarts.delete(toolCallId);
            void postEvent(runId, {
              eventType: "tool_finished",
              runId,
              ...(sessionKey ? { sessionKey } : {}),
              ...(toolCallId ? { toolCallId } : {}),
              ...((asNonEmptyString(event.data?.name) ?? start?.toolName)
                ? { toolName: asNonEmptyString(event.data?.name) ?? start?.toolName }
                : {}),
              ...(start?.input !== undefined ? { input: start.input } : {}),
              ...(event.data?.result !== undefined ? { output: event.data.result } : {}),
              ...(event.data?.isError === true &&
              asNonEmptyString((event.data?.result as Record<string, unknown> | undefined)?.error)
                ? {
                    error: asNonEmptyString(
                      (event.data?.result as Record<string, unknown> | undefined)?.error,
                    ),
                  }
                : {}),
              ...(start?.startedAt ? { startedAt: start.startedAt } : {}),
              ...(toIsoTimestamp(event.ts, event.ts)
                ? { endedAt: toIsoTimestamp(event.ts, event.ts) }
                : {}),
            });
          }
        }
      });
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
