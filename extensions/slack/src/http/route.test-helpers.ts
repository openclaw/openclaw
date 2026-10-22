import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { canonicalizeWebhookRouteKey } from "openclaw/plugin-sdk/webhook-targets";

export function installSlackHttpTestRegistry() {
  const registry = createTestRegistry();
  setActivePluginRegistry(registry);
  return registry;
}

export function createSlackHttpTestDispatcher(registry: ReturnType<typeof createTestRegistry>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = canonicalizeWebhookRouteKey(new URL(req.url ?? "/", "http://localhost").pathname);
    const route = registry.httpRoutes.find(
      (entry) => canonicalizeWebhookRouteKey(entry.path) === path,
    );
    return route ? (await route.handler(req, res)) !== false : false;
  };
}
