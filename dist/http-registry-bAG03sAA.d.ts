import { i as PluginRegistry } from "./registry-types-D8znGoeh.js";
import { t as PluginHttpRouteRegistration } from "./registry-DD9O67NC.js";
import { IncomingMessage, ServerResponse } from "node:http";

//#region src/plugins/http-registry.d.ts
type PluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
declare function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  replaceExisting?: boolean;
  pluginId?: string;
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void;
//#endregion
export { registerPluginHttpRoute as n, PluginHttpRouteHandler as t };