import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginRegistry } from "./registry.js";
export type PluginHttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
export declare function registerPluginHttpRoute(params: {
    path?: string | null;
    fallbackPath?: string | null;
    handler: PluginHttpRouteHandler;
    pluginId?: string;
    source?: string;
    accountId?: string;
    log?: (message: string) => void;
    registry?: PluginRegistry;
}): () => void;
