import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  type CompletionRunContext,
  openCompletionContextStore,
  registerAgentCompletionDelivery,
  storeCompletionDispatch,
} from "./src/completion.js";
import {
  type ConfiguredWebhookIdempotencyConfig,
  resolveWebhooksPluginRuntimeConfig,
} from "./src/config.js";
import { createTaskFlowWebhookRequestHandler } from "./src/http.js";
import { createWebhookRelayConnector } from "./src/relay.js";
import { buildWebhookTargets } from "./src/targets.js";

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

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const runtimeConfig = resolveWebhooksPluginRuntimeConfig({ pluginConfig: api.pluginConfig });
  const routes = runtimeConfig.routes;
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = buildWebhookTargets({ api, routes });
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
    onAgentCompletionDispatch: async (dispatch) => {
      await storeCompletionDispatch({
        store: completionContextStore,
        fallback: pendingCompletionBySessionKey,
        dispatch,
      });
    },
    loadChannelOutboundAdapter: api.runtime.channel?.outbound?.loadAdapter?.bind(
      api.runtime.channel.outbound,
    ),
    logger: api.logger,
  });

  if (routes.some((route) => route.dispatchMode === "agent" && route.agent.onCompletion)) {
    registerAgentCompletionDelivery({
      api,
      pendingCompletionBySessionKey,
      completionContextStore,
    });
  }

  for (const [path] of targetsByPath) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
  }

  for (const route of routes) {
    const sessionSuffix =
      route.dispatchMode === "taskflow" ? ` for session ${route.sessionKey}` : "";
    api.logger.info?.(
      `[webhooks] registered route ${route.routeId} on ${route.path}${sessionSuffix}`,
    );
  }

  if (runtimeConfig.relay) {
    const relay = createWebhookRelayConnector({
      cfg: api.config,
      relay: runtimeConfig.relay,
      targetsByPath,
      ...(hasIdempotency(routes) ? { idempotencyStore: openIdempotencyStore(api) } : {}),
      scheduleSessionTurn: api.session?.workflow?.scheduleSessionTurn ?? api.scheduleSessionTurn,
      onAgentCompletionDispatch: async (dispatch) => {
        await storeCompletionDispatch({
          store: completionContextStore,
          fallback: pendingCompletionBySessionKey,
          dispatch,
        });
      },
      loadChannelOutboundAdapter: api.runtime.channel?.outbound?.loadAdapter?.bind(
        api.runtime.channel.outbound,
      ),
      logger: api.logger,
    });
    relay.start();
    api.lifecycle.registerRuntimeLifecycle({
      id: "webhook-relay",
      description: "Webhooks relay connector cleanup.",
      cleanup: () => relay.stop(),
    });
    api.logger.info?.(`[webhooks] relay websocket connector started`);
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
