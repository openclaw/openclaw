import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import type { MonitorIMessageOpts } from "./types.js";
export declare function monitorIMessageProvider(opts?: MonitorIMessageOpts): Promise<void>;
export declare const __testing: {
    resolveIMessageRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
};
