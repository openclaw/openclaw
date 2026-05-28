import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  type CompletionRunContext,
  openCompletionContextStore,
  registerAgentCompletionDelivery,
  storeCompletionDispatch,
} from "./src/completion.js";
import {
  type ConfiguredWebhookAuth,
  type ConfiguredWebhookIdempotencyConfig,
  resolveWebhooksPluginConfig,
} from "./src/config.js";
import { createTaskFlowWebhookRequestHandler, type WebhookTarget } from "./src/http.js";

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

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({ pluginConfig: api.pluginConfig });
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
      target = { ...commonTarget, dispatchMode: "ack" };
    } else if (route.dispatchMode === "agent") {
      target = {
        ...commonTarget,
        dispatchMode: "agent",
        sessionKey: route.sessionKey,
        agent: route.agent,
      };
    } else if (route.dispatchMode === "deliver") {
      target = { ...commonTarget, dispatchMode: "deliver", delivery: route.delivery };
    } else {
      target = {
        ...commonTarget,
        dispatchMode: "taskflow",
        secretInput: route.secret,
        defaultControllerId: route.controllerId,
        ...(route.taskflow ? { taskflow: route.taskflow } : {}),
        taskFlow: api.runtime.tasks.managedFlows.bindSession({ sessionKey: route.sessionKey }),
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
