import { processSchema } from "./bash-tools.schemas.js";
import type { AgentToolWithMeta } from "./tools/common.js";
export type ProcessToolDefaults = {
    cleanupMs?: number;
    hasCronTool?: boolean;
    scopeKey?: string;
};
export declare function createProcessTool(defaults?: ProcessToolDefaults): AgentToolWithMeta<typeof processSchema, unknown>;
export declare const processTool: AgentToolWithMeta<import("typebox").TObject<{
    action: import("typebox").TString;
    sessionId: import("typebox").TOptional<import("typebox").TString>;
    data: import("typebox").TOptional<import("typebox").TString>;
    keys: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    hex: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
    literal: import("typebox").TOptional<import("typebox").TString>;
    text: import("typebox").TOptional<import("typebox").TString>;
    bracketed: import("typebox").TOptional<import("typebox").TBoolean>;
    eof: import("typebox").TOptional<import("typebox").TBoolean>;
    offset: import("typebox").TOptional<import("typebox").TNumber>;
    limit: import("typebox").TOptional<import("typebox").TNumber>;
    timeout: import("typebox").TOptional<import("typebox").TNumber>;
}>, unknown>;
