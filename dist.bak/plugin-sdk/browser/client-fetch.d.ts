import { loadConfig } from "../config/config.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
type LoopbackBrowserAuthDeps = {
    loadConfig: typeof loadConfig;
    resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
    getBridgeAuthForPort: typeof getBridgeAuthForPort;
};
declare function withLoopbackBrowserAuthImpl(url: string, init: (RequestInit & {
    timeoutMs?: number;
}) | undefined, deps: LoopbackBrowserAuthDeps): RequestInit & {
    timeoutMs?: number;
};
export declare function fetchBrowserJson<T>(url: string, init?: RequestInit & {
    timeoutMs?: number;
}): Promise<T>;
export declare const __test: {
    withLoopbackBrowserAuth: typeof withLoopbackBrowserAuthImpl;
};
export {};
