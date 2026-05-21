import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { type ConfiguredWebhookAuth, resolveWebhooksPluginConfig } from "./src/config.js";
import { createTaskFlowWebhookRequestHandler, type WebhookTarget } from "./src/http.js";

function usesLegacySharedSecretHeader(auth: ConfiguredWebhookAuth): boolean {
  return auth.mode === "bearer" && auth.legacySharedHeader === true;
}

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({
    pluginConfig: api.pluginConfig,
  });
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = new Map<string, WebhookTarget[]>();
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
  });

  for (const route of routes) {
    const target: WebhookTarget =
      route.dispatchMode === "ack"
        ? {
            routeId: route.routeId,
            path: route.path,
            dispatchMode: "ack",
            auth: route.auth,
            secretConfigPath: `plugins.entries.webhooks.routes.${route.routeId}.auth.secret`,
            event: route.event,
            ...(route.events ? { events: route.events } : {}),
            ...(route.idempotency ? { idempotency: route.idempotency } : {}),
          }
        : {
            routeId: route.routeId,
            path: route.path,
            dispatchMode: "taskflow",
            auth: route.auth,
            secretInput: route.secret,
            secretConfigPath: usesLegacySharedSecretHeader(route.auth)
              ? `plugins.entries.webhooks.routes.${route.routeId}.secret`
              : `plugins.entries.webhooks.routes.${route.routeId}.auth.secret`,
            defaultControllerId: route.controllerId,
            event: route.event,
            ...(route.events ? { events: route.events } : {}),
            ...(route.idempotency ? { idempotency: route.idempotency } : {}),
            taskFlow: api.runtime.tasks.managedFlows.bindSession({
              sessionKey: route.sessionKey,
            }),
          };
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
    "Authenticated inbound webhooks that bind external automation to OpenClaw TaskFlows.",
  register(api: OpenClawPluginApi) {
    registerWebhookRoutes(api);
  },
});
