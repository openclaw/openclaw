import type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeHandle } from "../runtime/types.js";
import type { SessionAcpMeta } from "./manager.types.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
export declare function resolveManagerRuntimeCapabilities(params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
}): Promise<AcpRuntimeCapabilities>;
export declare function applyManagerRuntimeControls(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    meta: SessionAcpMeta;
    getCachedRuntimeState: (sessionKey: string) => CachedRuntimeState | null;
}): Promise<void>;
