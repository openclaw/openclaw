import { Type } from "typebox";
export declare const ConfigGetParamsSchema: Type.TObject<{}>;
export declare const ConfigSetParamsSchema: Type.TObject<{
    raw: Type.TString;
    baseHash: Type.TOptional<Type.TString>;
}>;
export declare const ConfigApplyParamsSchema: Type.TObject<{
    raw: Type.TString;
    baseHash: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    deliveryContext: Type.TOptional<Type.TObject<{
        channel: Type.TOptional<Type.TString>;
        to: Type.TOptional<Type.TString>;
        accountId: Type.TOptional<Type.TString>;
        threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    }>>;
    note: Type.TOptional<Type.TString>;
    restartDelayMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ConfigPatchParamsSchema: Type.TObject<{
    raw: Type.TString;
    baseHash: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    deliveryContext: Type.TOptional<Type.TObject<{
        channel: Type.TOptional<Type.TString>;
        to: Type.TOptional<Type.TString>;
        accountId: Type.TOptional<Type.TString>;
        threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    }>>;
    note: Type.TOptional<Type.TString>;
    restartDelayMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ConfigSchemaParamsSchema: Type.TObject<{}>;
export declare const ConfigSchemaLookupParamsSchema: Type.TObject<{
    path: Type.TString;
}>;
export declare const UpdateStatusParamsSchema: Type.TObject<{}>;
export declare const UpdateRunParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    deliveryContext: Type.TOptional<Type.TObject<{
        channel: Type.TOptional<Type.TString>;
        to: Type.TOptional<Type.TString>;
        accountId: Type.TOptional<Type.TString>;
        threadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    }>>;
    note: Type.TOptional<Type.TString>;
    continuationMessage: Type.TOptional<Type.TString>;
    restartDelayMs: Type.TOptional<Type.TInteger>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export declare const ConfigUiHintSchema: Type.TObject<{
    label: Type.TOptional<Type.TString>;
    help: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    group: Type.TOptional<Type.TString>;
    order: Type.TOptional<Type.TInteger>;
    advanced: Type.TOptional<Type.TBoolean>;
    sensitive: Type.TOptional<Type.TBoolean>;
    placeholder: Type.TOptional<Type.TString>;
    itemTemplate: Type.TOptional<Type.TUnknown>;
}>;
export declare const ConfigSchemaResponseSchema: Type.TObject<{
    schema: Type.TUnknown;
    uiHints: Type.TRecord<"^.*$", Type.TObject<{
        label: Type.TOptional<Type.TString>;
        help: Type.TOptional<Type.TString>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
        group: Type.TOptional<Type.TString>;
        order: Type.TOptional<Type.TInteger>;
        advanced: Type.TOptional<Type.TBoolean>;
        sensitive: Type.TOptional<Type.TBoolean>;
        placeholder: Type.TOptional<Type.TString>;
        itemTemplate: Type.TOptional<Type.TUnknown>;
    }>>;
    version: Type.TString;
    generatedAt: Type.TString;
}>;
export declare const ConfigSchemaLookupChildSchema: Type.TObject<{
    key: Type.TString;
    path: Type.TString;
    type: Type.TOptional<Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>>;
    required: Type.TBoolean;
    hasChildren: Type.TBoolean;
    hint: Type.TOptional<Type.TObject<{
        label: Type.TOptional<Type.TString>;
        help: Type.TOptional<Type.TString>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
        group: Type.TOptional<Type.TString>;
        order: Type.TOptional<Type.TInteger>;
        advanced: Type.TOptional<Type.TBoolean>;
        sensitive: Type.TOptional<Type.TBoolean>;
        placeholder: Type.TOptional<Type.TString>;
        itemTemplate: Type.TOptional<Type.TUnknown>;
    }>>;
    hintPath: Type.TOptional<Type.TString>;
}>;
export declare const ConfigSchemaLookupResultSchema: Type.TObject<{
    path: Type.TString;
    schema: Type.TUnknown;
    hint: Type.TOptional<Type.TObject<{
        label: Type.TOptional<Type.TString>;
        help: Type.TOptional<Type.TString>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
        group: Type.TOptional<Type.TString>;
        order: Type.TOptional<Type.TInteger>;
        advanced: Type.TOptional<Type.TBoolean>;
        sensitive: Type.TOptional<Type.TBoolean>;
        placeholder: Type.TOptional<Type.TString>;
        itemTemplate: Type.TOptional<Type.TUnknown>;
    }>>;
    hintPath: Type.TOptional<Type.TString>;
    children: Type.TArray<Type.TObject<{
        key: Type.TString;
        path: Type.TString;
        type: Type.TOptional<Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>>;
        required: Type.TBoolean;
        hasChildren: Type.TBoolean;
        hint: Type.TOptional<Type.TObject<{
            label: Type.TOptional<Type.TString>;
            help: Type.TOptional<Type.TString>;
            tags: Type.TOptional<Type.TArray<Type.TString>>;
            group: Type.TOptional<Type.TString>;
            order: Type.TOptional<Type.TInteger>;
            advanced: Type.TOptional<Type.TBoolean>;
            sensitive: Type.TOptional<Type.TBoolean>;
            placeholder: Type.TOptional<Type.TString>;
            itemTemplate: Type.TOptional<Type.TUnknown>;
        }>>;
        hintPath: Type.TOptional<Type.TString>;
    }>>;
}>;
