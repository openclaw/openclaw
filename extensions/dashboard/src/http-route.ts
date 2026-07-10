// Plugin HTTP route adapter for serving approved custom-widget assets.
//
// Registered with `auth:"plugin"` (unauthenticated) because sandboxed iframes
// carry no device token — safe ONLY because `serveWidgetAsset` is static-file
// only. This adapter just turns the node request into `{ method, pathname }` and
// delegates; all jail/gate/header logic lives in `serve.ts`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { serveWidgetAsset, WIDGETS_ROUTE_PREFIX } from "./serve.js";
import type { DashboardStore } from "./store.js";

export { WIDGETS_ROUTE_PREFIX };

export type WidgetHttpRouteHandler = {
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
};

/** Creates the HTTP route handler bound to the shared dashboard store. */
export function createWidgetHttpRouteHandler(params: {
  store: DashboardStore;
  stateDir?: string;
}): WidgetHttpRouteHandler {
  return {
    async handleHttpRequest(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      return await serveWidgetAsset({ method: req.method, pathname: url.pathname }, res, {
        store: params.store,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      });
    },
  };
}
