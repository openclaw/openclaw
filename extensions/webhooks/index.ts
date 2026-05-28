import { definePluginEntry, type OpenClawPluginApi, type PluginJsonValue } from "./api.js";
import {
  type ConfiguredWebhookAuth,
  type ConfiguredWebhookDeliveryConfig,
  type ConfiguredWebhookIdempotencyConfig,
  resolveWebhooksPluginConfig,
} from "./src/config.js";
import {
  createTaskFlowWebhookRequestHandler,
  deliverWebhookCompletion,
  type WebhookAgentCompletionDispatch,
  type WebhookTarget,
} from "./src/http.js";

type CompletionRunContext = {
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

const COMPLETION_CONTEXT_NAMESPACE = "agent-completion-delivery";
const COMPLETION_PENDING_TTL_MS = 10 * 60 * 1000;

type CompletionContextStore = {
  register(key: string, value: CompletionRunContext, opts?: { ttlMs?: number }): Promise<void>;
  lookup?(key: string): Promise<CompletionRunContext | undefined>;
  consume(key: string): Promise<CompletionRunContext | undefined>;
};

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
  if (!isRecord(value)) {
    return undefined;
  }
  return normalizeAssistantText(value.text);
}

function appendAssistantDelta(currentText: string | undefined, value: unknown): string | undefined {
  if (!isRecord(value)) {
    return currentText;
  }
  const delta = readString(value.delta);
  if (!delta) {
    return currentText;
  }
  return `${currentText ?? ""}${delta}`;
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
  return {
    routeId,
    sessionKey,
    delivery: value.delivery as ConfiguredWebhookDeliveryConfig,
    ...(readString(value.eventType) ? { eventType: readString(value.eventType) } : {}),
    ...(readString(value.idempotencyKey)
      ? { idempotencyKey: readString(value.idempotencyKey) }
      : {}),
    body: value.body,
    rawBody,
    headers: Object.fromEntries(
      Object.entries(value.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    ...(readString(value.text) ? { text: readString(value.text) } : {}),
    ...(typeof value.delivered === "boolean" ? { delivered: value.delivered } : {}),
  };
}

function usesLegacySharedSecretHeader(auth: ConfiguredWebhookAuth): boolean {
  return auth.mode === "bearer" && auth.legacySharedHeader === true;
}

function hasIdempotency(routes: { idempotency?: ConfiguredWebhookIdempotencyConfig }[]): boolean {
  return routes.some((route) => route.idempotency);
}

function openIdempotencyStore(api: OpenClawPluginApi) {
  try {
    return api.runtime.state?.openKeyedStore<{
      routeId: string;
      idempotencyKey: string;
      firstSeenAt: number;
    }>({
      namespace: "webhook-idempotency",
      maxEntries: 25_000,
      defaultTtlMs: 24 * 60 * 60 * 1000,
    });
  } catch (error) {
    api.logger.warn?.(
      `[webhooks] persistent idempotency store unavailable; falling back to in-process dedupe: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    return undefined;
  }
}

function openCompletionContextStore(api: OpenClawPluginApi): CompletionContextStore | undefined {
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

async function storeCompletionContext(params: {
  store?: CompletionContextStore;
  fallback: Map<string, CompletionRunContext>;
  context: CompletionRunContext;
}): Promise<void> {
  params.fallback.set(params.context.sessionKey, params.context);
  await params.store?.register(params.context.sessionKey, params.context, {
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

function registerAgentCompletionDelivery(
  api: OpenClawPluginApi,
  pendingCompletionBySessionKey: Map<string, CompletionRunContext>,
  completionContextStore: CompletionContextStore | undefined,
): void {
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
        api.logger.warn?.("[webhooks] skipped empty agent completion delivery", {
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
        logger: api.logger,
        cfg: api.config,
      });
      await consumeCompletionContext({
        store: completionContextStore,
        fallback: pendingCompletionBySessionKey,
        sessionKey: current.sessionKey,
      });
      activeCompletionByRunId.delete(event.runId);
      api.logger.info?.("[webhooks] delivered agent completion", {
        routeId: current.routeId,
        sessionKey: current.sessionKey,
        runId: event.runId,
      });
    },
  });
}

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({
    pluginConfig: api.pluginConfig,
  });
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = new Map<string, WebhookTarget[]>();
  const pendingCompletionBySessionKey = new Map<string, CompletionRunContext>();
  const completionContextStore = routes.some(
    (route) => route.dispatchMode === "agent" && route.agent.onCompletion,
  )
    ? openCompletionContextStore(api)
    : undefined;
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
    ...(hasIdempotency(routes) ? { idempotencyStore: openIdempotencyStore(api) } : {}),
    scheduleSessionTurn: api.session?.workflow?.scheduleSessionTurn ?? api.scheduleSessionTurn,
    onAgentCompletionDispatch: async (dispatch: WebhookAgentCompletionDispatch) => {
      await storeCompletionContext({
        store: completionContextStore,
        fallback: pendingCompletionBySessionKey,
        context: {
          routeId: dispatch.routeId,
          sessionKey: dispatch.sessionKey,
          delivery: dispatch.delivery,
          ...(dispatch.context.eventType ? { eventType: dispatch.context.eventType } : {}),
          ...(dispatch.context.idempotencyKey
            ? { idempotencyKey: dispatch.context.idempotencyKey }
            : {}),
          body: structuredClone(dispatch.context.body) as PluginJsonValue,
          rawBody: dispatch.context.rawBody,
          headers: dispatch.context.headers,
        },
      });
    },
    loadChannelOutboundAdapter: api.runtime.channel?.outbound?.loadAdapter?.bind(
      api.runtime.channel.outbound,
    ),
    logger: api.logger,
  });

  if (routes.some((route) => route.dispatchMode === "agent" && route.agent.onCompletion)) {
    registerAgentCompletionDelivery(api, pendingCompletionBySessionKey, completionContextStore);
  }

  for (const route of routes) {
    let target: WebhookTarget;
    const secretConfigPath = usesLegacySharedSecretHeader(route.auth)
      ? `plugins.entries.webhooks.routes.${route.routeId}.secret`
      : `plugins.entries.webhooks.routes.${route.routeId}.auth.secret`;
    const commonTarget = {
      routeId: route.routeId,
      path: route.path,
      auth: route.auth,
      secretConfigPath,
      event: route.event,
      ...(route.events ? { events: route.events } : {}),
      ...(route.idempotency ? { idempotency: route.idempotency } : {}),
      ...(route.prompt ? { prompt: route.prompt } : {}),
      ...(route.skills ? { skills: route.skills } : {}),
    };
    if (route.dispatchMode === "ack") {
      target = {
        ...commonTarget,
        dispatchMode: "ack",
      };
    } else if (route.dispatchMode === "agent") {
      target = {
        ...commonTarget,
        dispatchMode: "agent",
        sessionKey: route.sessionKey,
        agent: route.agent,
      };
    } else if (route.dispatchMode === "deliver") {
      target = {
        ...commonTarget,
        dispatchMode: "deliver",
        delivery: route.delivery,
      };
    } else {
      target = {
        ...commonTarget,
        dispatchMode: "taskflow",
        secretInput: route.secret,
        defaultControllerId: route.controllerId,
        ...(route.taskflow ? { taskflow: route.taskflow } : {}),
        taskFlow: api.runtime.tasks.managedFlows.bindSession({
          sessionKey: route.sessionKey,
        }),
      };
    }
    targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
    api.registerHttpRoute({
      path: target.path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
    const sessionSuffix =
      route.dispatchMode === "taskflow" ? ` for session ${route.sessionKey}` : "";
    api.logger.info?.(
      `[webhooks] registered route ${route.routeId} on ${route.path}${sessionSuffix}`,
    );
  }
}

export default definePluginEntry({
  id: "webhooks",
  name: "Webhooks",
  description:
    "Authenticated inbound webhooks that trigger OpenClaw agents, TaskFlows, or channel delivery.",
  register(api: OpenClawPluginApi) {
    registerWebhookRoutes(api);
  },
});
