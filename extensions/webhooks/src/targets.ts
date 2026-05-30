import type { OpenClawPluginApi } from "../api.js";
import type { ConfiguredWebhookAuth, ConfiguredWebhookRouteConfig } from "./config.js";
import type { WebhookTarget } from "./http.js";

function usesLegacySharedSecretHeader(auth: ConfiguredWebhookAuth): boolean {
  return auth.mode === "bearer" && auth.legacySharedHeader === true;
}

export function buildWebhookTargets(params: {
  api: OpenClawPluginApi;
  routes: ConfiguredWebhookRouteConfig[];
}): Map<string, WebhookTarget[]> {
  const targetsByPath = new Map<string, WebhookTarget[]>();

  for (const route of params.routes) {
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
      ...(route.verification ? { verification: route.verification } : {}),
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
        taskFlow: params.api.runtime.tasks.managedFlows.bindSession({
          sessionKey: route.sessionKey,
        }),
      };
    }
    targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
  }

  return targetsByPath;
}
