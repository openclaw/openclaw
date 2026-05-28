import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerWebhooksCli } from "./src/cli.js";
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
import { registerWebhooksGatewayMethods } from "./src/gateway.js";
import { createTaskFlowWebhookRequestHandler } from "./src/http.js";
import { createWebhookSubscriptionStore } from "./src/subscriptions.js";
import { buildWebhookTargets } from "./src/targets.js";

function adaptLogger(api: OpenClawPluginApi) {
  return {
    info: (message: string, details?: unknown) => {
      api.logger.info(details === undefined ? message : `${message} ${JSON.stringify(details)}`);
    },
    warn: (message: string, details?: unknown) => {
      api.logger.warn(details === undefined ? message : `${message} ${JSON.stringify(details)}`);
    },
  };
}

function hasIdempotency(routes: { idempotency?: ConfiguredWebhookIdempotencyConfig }[]): boolean {
  return routes.some((route) => route.idempotency);
}

function openIdempotencyStore(api: OpenClawPluginApi, opts?: { warnOnFailure?: boolean }) {
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
    if (opts?.warnOnFailure) {
      api.logger.warn?.(
        `[webhooks] persistent idempotency store unavailable; falling back to in-process dedupe: ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
    return undefined;
  }
}

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const runtimeConfig = resolveWebhooksPluginRuntimeConfig({ pluginConfig: api.pluginConfig });
  const routes = runtimeConfig.routes;

  const targetsByPath = buildWebhookTargets({ api, routes });
  const logger = adaptLogger(api);
  const subscriptionStore = createWebhookSubscriptionStore({
    api,
    staticRoutes: routes,
    publicUrl: runtimeConfig.publicUrl,
  });
  const pendingCompletionBySessionKey = new Map<string, CompletionRunContext>();
  const completionContextStore = routes.some(
    (route) => route.dispatchMode === "agent" && route.agent.onCompletion,
  )
    ? openCompletionContextStore(api)
    : undefined;
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
    resolveTargetsByPath: async () => {
      const dynamicTargetsByPath = await subscriptionStore.loadTargets();
      return new Map([...dynamicTargetsByPath, ...targetsByPath]);
    },
    idempotencyStore: openIdempotencyStore(api, { warnOnFailure: hasIdempotency(routes) }),
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
    logger,
  });

  registerWebhooksGatewayMethods({
    api,
    cfg: api.config,
    store: subscriptionStore,
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
    logger,
  });

  api.registerCli(({ program }) => registerWebhooksCli({ program }), {
    parentPath: ["webhooks"],
    commands: ["subscribe", "list", "remove", "test"],
  });

  if (routes.some((route) => route.dispatchMode === "agent" && route.agent.onCompletion)) {
    registerAgentCompletionDelivery({
      api,
      pendingCompletionBySessionKey,
      completionContextStore,
      logger,
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

  api.registerHttpRoute({
    path: "/plugins/webhooks",
    auth: "plugin",
    match: "prefix",
    replaceExisting: true,
    handler,
  });

  for (const route of routes) {
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
