import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
export type PluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
export declare function registerPluginHttpRoute(params: {
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
