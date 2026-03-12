import { resolveOpenProviderRuntimeGroupPolicy, resolveDefaultGroupPolicy } from "../../config/runtime-group-policy.js";
import type { MonitorSlackOpts } from "./types.js";
export declare function monitorSlackProvider(opts?: MonitorSlackOpts): Promise<void>;
export declare const __testing: {
    resolveSlackRuntimeGroupPolicy: typeof resolveOpenProviderRuntimeGroupPolicy;
    resolveDefaultGroupPolicy: typeof resolveDefaultGroupPolicy;
};
