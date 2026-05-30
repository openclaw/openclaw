import type { OpenClawPluginApi, PluginJsonValue } from "../api.js";
import type { ConfiguredWebhookDeliveryConfig } from "./config.js";
import { deliverWebhookCompletion } from "./delivery.js";
import type { WebhookAgentCompletionDispatch } from "./dispatch.js";
import type { WebhookLogger } from "./http.js";

export type CompletionRunContext = {
  routeId: string;
  sessionKey: string;
  delivery: ConfiguredWebhookDeliveryConfig;
  eventType?: string;
  idempotencyKey?: string;
  body: PluginJsonValue;
  rawBody: string;
  headers: Record<string, string>;
  text?: string;
  delivered?: boolean;
};

type CompletionContextStore = {
  register(key: string, value: CompletionRunContext, opts?: { ttlMs?: number }): Promise<void>;
  lookup?(key: string): Promise<CompletionRunContext | undefined>;
  consume(key: string): Promise<CompletionRunContext | undefined>;
};

const COMPLETION_CONTEXT_NAMESPACE = "agent-completion-delivery";
const COMPLETION_PENDING_TTL_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeAssistantText(value: unknown): string | undefined {
  return readString(value)?.trim();
}

function readAssistantSnapshot(value: unknown): string | undefined {
  return isRecord(value) ? normalizeAssistantText(value.text) : undefined;
}

function isPluginJsonValue(value: unknown): value is PluginJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isPluginJsonValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isPluginJsonValue);
}

function appendAssistantDelta(currentText: string | undefined, value: unknown): string | undefined {
  if (!isRecord(value)) {
    return currentText;
  }
  const delta = readString(value.delta);
  return delta ? `${currentText ?? ""}${delta}` : currentText;
}

function readCompletionContext(value: unknown): CompletionRunContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const routeId = readString(value.routeId);
  const sessionKey = readString(value.sessionKey);
  const rawBody = typeof value.rawBody === "string" ? value.rawBody : "";
  if (!routeId || !sessionKey || !isRecord(value.delivery) || !isRecord(value.headers)) {
    return undefined;
  }
  const eventType = readString(value.eventType);
  const idempotencyKey = readString(value.idempotencyKey);
  const text = readString(value.text);
  const body = isPluginJsonValue(value.body) ? value.body : {};
  return {
    routeId,
    sessionKey,
    delivery: value.delivery as ConfiguredWebhookDeliveryConfig,
    ...(eventType ? { eventType } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    body,
    rawBody,
    headers: Object.fromEntries(
      Object.entries(value.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    ...(text ? { text } : {}),
    ...(typeof value.delivered === "boolean" ? { delivered: value.delivered } : {}),
  };
}

export function openCompletionContextStore(
  api: OpenClawPluginApi,
): CompletionContextStore | undefined {
  try {
    return api.runtime.state?.openKeyedStore<CompletionRunContext>({
      namespace: "webhook-agent-completion",
      maxEntries: 5_000,
      defaultTtlMs: COMPLETION_PENDING_TTL_MS,
    });
  } catch (error) {
    api.logger.warn?.(
      `[webhooks] persistent completion store unavailable; falling back to in-process completion context: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    return undefined;
  }
}

export async function storeCompletionDispatch(params: {
  store?: CompletionContextStore;
  fallback: Map<string, CompletionRunContext>;
  dispatch: WebhookAgentCompletionDispatch;
}): Promise<void> {
  const context: CompletionRunContext = {
    routeId: params.dispatch.routeId,
    sessionKey: params.dispatch.sessionKey,
    delivery: params.dispatch.delivery,
    ...(params.dispatch.context.eventType ? { eventType: params.dispatch.context.eventType } : {}),
    ...(params.dispatch.context.idempotencyKey
      ? { idempotencyKey: params.dispatch.context.idempotencyKey }
      : {}),
    body: structuredClone(params.dispatch.context.body) as PluginJsonValue,
    rawBody: params.dispatch.context.rawBody,
    headers: params.dispatch.context.headers,
  };
  params.fallback.set(context.sessionKey, context);
  await params.store?.register(context.sessionKey, context, {
    ttlMs: COMPLETION_PENDING_TTL_MS,
  });
}

async function consumeCompletionContext(params: {
  store?: CompletionContextStore;
  fallback: Map<string, CompletionRunContext>;
  sessionKey: string;
}): Promise<CompletionRunContext | undefined> {
  const fallback = params.fallback.get(params.sessionKey);
  params.fallback.delete(params.sessionKey);
  return (await params.store?.consume(params.sessionKey)) ?? fallback;
}

async function lookupCompletionContext(params: {
  store?: CompletionContextStore;
  fallback: Map<string, CompletionRunContext>;
  sessionKey: string;
}): Promise<CompletionRunContext | undefined> {
  return (
    (await params.store?.lookup?.(params.sessionKey)) ?? params.fallback.get(params.sessionKey)
  );
}

export function registerAgentCompletionDelivery(params: {
  api: OpenClawPluginApi;
  pendingCompletionBySessionKey: Map<string, CompletionRunContext>;
  completionContextStore: CompletionContextStore | undefined;
  logger?: WebhookLogger;
}): void {
  const { api, completionContextStore, pendingCompletionBySessionKey } = params;
  const activeCompletionByRunId = new Map<string, CompletionRunContext>();

  api.agent.events.registerAgentEventSubscription({
    id: "webhook-agent-completion-delivery",
    streams: ["assistant", "lifecycle"],
    async handle(event, ctx) {
      if (event.stream === "lifecycle" && event.data.phase === "start" && event.sessionKey) {
        const pending = await lookupCompletionContext({
          store: completionContextStore,
          fallback: pendingCompletionBySessionKey,
          sessionKey: event.sessionKey,
        });
        if (pending) {
          activeCompletionByRunId.set(event.runId, pending);
          ctx.setRunContext(COMPLETION_CONTEXT_NAMESPACE, pending);
        }
      }

      const current =
        readCompletionContext(ctx.getRunContext(COMPLETION_CONTEXT_NAMESPACE)) ??
        activeCompletionByRunId.get(event.runId);
      if (!current) {
        return;
      }

      if (event.stream === "assistant") {
        const text =
          readAssistantSnapshot(event.data) ?? appendAssistantDelta(current.text, event.data);
        if (text) {
          const next = { ...current, text };
          activeCompletionByRunId.set(event.runId, next);
          ctx.setRunContext(COMPLETION_CONTEXT_NAMESPACE, next);
        }
        return;
      }

      if (event.data.phase !== "end" || current.delivered) {
        return;
      }

      const text = normalizeAssistantText(current.text);
      if (!text) {
        params.logger?.warn?.("[webhooks] skipped empty agent completion delivery", {
          routeId: current.routeId,
          sessionKey: current.sessionKey,
          runId: event.runId,
        });
        return;
      }

      const delivered = { ...current, delivered: true };
      activeCompletionByRunId.set(event.runId, delivered);
      ctx.setRunContext(COMPLETION_CONTEXT_NAMESPACE, delivered);
      await deliverWebhookCompletion({
        routeId: current.routeId,
        delivery: current.delivery,
        context: {
          routeId: current.routeId,
          ...(current.eventType ? { eventType: current.eventType } : {}),
          ...(current.idempotencyKey ? { idempotencyKey: current.idempotencyKey } : {}),
          body: current.body,
          rawBody: current.rawBody,
          headers: current.headers,
        },
        completionText: text,
        loadChannelOutboundAdapter: api.runtime.channel?.outbound?.loadAdapter?.bind(
          api.runtime.channel.outbound,
        ),
        logger: params.logger,
        cfg: api.config,
      });
      await consumeCompletionContext({
        store: completionContextStore,
        fallback: pendingCompletionBySessionKey,
        sessionKey: current.sessionKey,
      });
      activeCompletionByRunId.delete(event.runId);
      params.logger?.info?.("[webhooks] delivered agent completion", {
        routeId: current.routeId,
        sessionKey: current.sessionKey,
        runId: event.runId,
      });
    },
  });
}
