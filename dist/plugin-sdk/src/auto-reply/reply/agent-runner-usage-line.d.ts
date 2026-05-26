import { type ModelCostConfig } from "../../utils/usage-format.js";
import type { ReplyPayload } from "../types.js";
export declare const formatResponseUsageLine: (params: {
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    showCost: boolean;
    costConfig?: ModelCostConfig;
}) => string | null;
export declare const appendUsageLine: (payloads: ReplyPayload[], line: string) => ReplyPayload[];
