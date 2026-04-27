import type { AnyAgentTool } from "./pi-tools.types.js";
export type RequiredParamGroup = {
    keys: readonly string[];
    allowEmpty?: boolean;
    label?: string;
    validator?: (record: Record<string, unknown>) => boolean;
};
declare function hasValidEditReplacements(record: Record<string, unknown>): boolean;
export declare const REQUIRED_PARAM_GROUPS: {
    readonly read: readonly [{
        readonly keys: readonly ["path"];
        readonly label: "path";
    }];
    readonly write: readonly [{
        readonly keys: readonly ["path"];
        readonly label: "path";
    }, {
        readonly keys: readonly ["content"];
        readonly label: "content";
    }];
    readonly edit: readonly [{
        readonly keys: readonly ["path"];
        readonly label: "path";
    }, {
        readonly keys: readonly ["edits"];
        readonly label: "edits";
        readonly validator: typeof hasValidEditReplacements;
    }];
};
export declare function getToolParamsRecord(params: unknown): Record<string, unknown> | undefined;
export declare function assertRequiredParams(record: Record<string, unknown> | undefined, groups: readonly RequiredParamGroup[], toolName: string): void;
export declare function wrapToolParamValidation(tool: AnyAgentTool, requiredParamGroups?: readonly RequiredParamGroup[]): AnyAgentTool;
export {};
