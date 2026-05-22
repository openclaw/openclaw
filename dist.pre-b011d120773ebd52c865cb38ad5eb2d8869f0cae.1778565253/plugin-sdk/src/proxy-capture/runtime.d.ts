import { type DebugProxySettings } from "./env.js";
import { closeDebugProxyCaptureStore, getDebugProxyCaptureStore, persistEventPayload, safeJsonString } from "./store.sqlite.js";
type DebugProxyCaptureStoreLike = Pick<ReturnType<typeof getDebugProxyCaptureStore>, "upsertSession" | "endSession" | "recordEvent">;
export type DebugProxyCaptureRuntimeDeps = {
    getStore?: (dbPath: string, blobDir: string) => DebugProxyCaptureStoreLike;
    closeStore?: typeof closeDebugProxyCaptureStore;
    persistEventPayload?: (store: DebugProxyCaptureStoreLike, payload: Parameters<typeof persistEventPayload>[1]) => ReturnType<typeof persistEventPayload>;
    safeJsonString?: typeof safeJsonString;
    fetchTarget?: typeof globalThis;
};
export declare function isDebugProxyGlobalFetchPatchInstalled(): boolean;
export declare function initializeDebugProxyCapture(mode: string, resolved?: DebugProxySettings, deps?: DebugProxyCaptureRuntimeDeps): void;
export declare function finalizeDebugProxyCapture(resolved?: DebugProxySettings, deps?: DebugProxyCaptureRuntimeDeps): void;
export declare function captureHttpExchange(params: {
    url: string;
    method: string;
    requestHeaders?: Headers | Record<string, string> | undefined;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
}, resolved?: DebugProxySettings, deps?: DebugProxyCaptureRuntimeDeps): void;
export declare function captureWsEvent(params: {
    url: string;
    direction: "outbound" | "inbound" | "local";
    kind: "ws-open" | "ws-frame" | "ws-close" | "error";
    flowId: string;
    payload?: string | Buffer;
    closeCode?: number;
    errorText?: string;
    meta?: Record<string, unknown>;
}): void;
export {};
