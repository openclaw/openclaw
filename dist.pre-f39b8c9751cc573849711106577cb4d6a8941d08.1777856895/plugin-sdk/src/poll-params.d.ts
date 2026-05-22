type PollCreationParamKind = "string" | "stringArray" | "number" | "boolean";
type PollCreationParamDef = {
    kind: PollCreationParamKind;
};
declare const SHARED_POLL_CREATION_PARAM_DEFS: {
    pollQuestion: {
        kind: "string";
    };
    pollOption: {
        kind: "stringArray";
    };
    pollDurationHours: {
        kind: "number";
    };
    pollMulti: {
        kind: "boolean";
    };
};
export declare const POLL_CREATION_PARAM_DEFS: Record<string, PollCreationParamDef>;
type SharedPollCreationParamName = keyof typeof SHARED_POLL_CREATION_PARAM_DEFS;
export declare const SHARED_POLL_CREATION_PARAM_NAMES: SharedPollCreationParamName[];
export declare function hasPollCreationParams(params: Record<string, unknown>): boolean;
export {};
