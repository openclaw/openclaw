import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
} from "openclaw/plugin-sdk/session-visibility";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { resolveWebhooksPluginConfig } from "./src/config.js";
import { createTaskFlowWebhookRequestHandler, type TaskFlowWebhookTarget } from "./src/http.js";

function createChildSessionKeyGuard(api: OpenClawPluginApi, requesterSessionKey: string) {
  const checker = createSessionVisibilityRowChecker({
    action: "status",
    requesterSessionKey,
    visibility: "tree",
    a2aPolicy: createAgentToAgentPolicy(api.config),
  });
  return (childSessionKey: string): boolean => {
    const normalizedChildSessionKey = childSessionKey.trim();
    if (!normalizedChildSessionKey) {
      return false;
    }
    if (normalizedChildSessionKey === requesterSessionKey) {
      return true;
    }
    const agentId = resolveAgentIdFromSessionKey(normalizedChildSessionKey);
    const storePath = api.runtime.agent.session.resolveStorePath(api.config.session?.store, {
      agentId,
    });
    const entry = api.runtime.agent.session.loadSessionStore(storePath, { clone: false })[
      normalizedChildSessionKey
    ];
    return checker.check({
      key: normalizedChildSessionKey,
      agentId,
      ...(entry?.spawnedBy ? { spawnedBy: entry.spawnedBy } : {}),
      ...(entry?.parentSessionKey ? { parentSessionKey: entry.parentSessionKey } : {}),
    }).allowed;
  };
}

function registerWebhookRoutes(api: OpenClawPluginApi): void {
  const routes = resolveWebhooksPluginConfig({
    pluginConfig: api.pluginConfig,
  });
  if (routes.length === 0) {
    return;
  }

  const targetsByPath = new Map<string, TaskFlowWebhookTarget[]>();
  const handler = createTaskFlowWebhookRequestHandler({
    cfg: api.config,
    targetsByPath,
  });

  for (const route of routes) {
    const taskFlow = api.runtime.tasks.managedFlows.bindSession({
      sessionKey: route.sessionKey,
    });
    const target: TaskFlowWebhookTarget = {
      routeId: route.routeId,
      path: route.path,
      secretInput: route.secret,
      secretConfigPath: `plugins.entries.webhooks.routes.${route.routeId}.secret`,
      defaultControllerId: route.controllerId,
      taskFlow,
      canUseChildSessionKey: createChildSessionKeyGuard(api, route.sessionKey),
    };
    targetsByPath.set(target.path, [...(targetsByPath.get(target.path) ?? []), target]);
    api.registerHttpRoute({
      path: target.path,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler,
    });
    api.logger.info?.(
      `[webhooks] registered route ${route.routeId} on ${route.path} for session ${route.sessionKey}`,
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
