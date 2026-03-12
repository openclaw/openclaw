export declare const ConfigGetParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const ConfigSetParamsSchema: import("@sinclair/typebox").TObject<{
    raw: import("@sinclair/typebox").TString;
    baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const ConfigApplyParamsSchema: import("@sinclair/typebox").TObject<{
    raw: import("@sinclair/typebox").TString;
    baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ConfigPatchParamsSchema: import("@sinclair/typebox").TObject<{
    raw: import("@sinclair/typebox").TString;
    baseHash: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ConfigSchemaParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const UpdateRunParamsSchema: import("@sinclair/typebox").TObject<{
    sessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    note: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    restartDelayMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    timeoutMs: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
}>;
export declare const ConfigUiHintSchema: import("@sinclair/typebox").TObject<{
    label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    help: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    group: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    order: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
    advanced: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    itemTemplate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
}>;
export declare const ConfigSchemaResponseSchema: import("@sinclair/typebox").TObject<{
    schema: import("@sinclair/typebox").TUnknown;
    uiHints: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TObject<{
        label: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        help: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        tags: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        group: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        order: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TInteger>;
        advanced: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        sensitive: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        placeholder: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        itemTemplate: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TUnknown>;
    }>>;
    version: import("@sinclair/typebox").TString;
    generatedAt: import("@sinclair/typebox").TString;
}>;
