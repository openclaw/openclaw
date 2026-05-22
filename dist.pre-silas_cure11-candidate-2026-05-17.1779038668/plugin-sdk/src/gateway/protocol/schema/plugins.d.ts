import { Type } from "typebox";
export declare const PluginJsonValueSchema: Type.TUnknown;
export declare const PluginControlUiDescriptorSchema: Type.TObject<{
    id: Type.TString;
    pluginId: Type.TString;
    pluginName: Type.TOptional<Type.TString>;
    surface: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"tool">, Type.TLiteral<"run">, Type.TLiteral<"settings">]>;
    label: Type.TString;
    description: Type.TOptional<Type.TString>;
    placement: Type.TOptional<Type.TString>;
    schema: Type.TOptional<Type.TUnknown>;
    requiredScopes: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export declare const PluginsUiDescriptorsParamsSchema: Type.TObject<{}>;
export declare const PluginsUiDescriptorsResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    descriptors: Type.TArray<Type.TObject<{
        id: Type.TString;
        pluginId: Type.TString;
        pluginName: Type.TOptional<Type.TString>;
        surface: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"tool">, Type.TLiteral<"run">, Type.TLiteral<"settings">]>;
        label: Type.TString;
        description: Type.TOptional<Type.TString>;
        placement: Type.TOptional<Type.TString>;
        schema: Type.TOptional<Type.TUnknown>;
        requiredScopes: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
}>;
export declare const PluginsSessionActionParamsSchema: Type.TObject<{
    pluginId: Type.TString;
    actionId: Type.TString;
    sessionKey: Type.TOptional<Type.TString>;
    payload: Type.TOptional<Type.TUnknown>;
}>;
export declare const PluginsSessionActionSuccessResultSchema: Type.TObject<{
    ok: Type.TLiteral<true>;
    result: Type.TOptional<Type.TUnknown>;
    continueAgent: Type.TOptional<Type.TBoolean>;
    reply: Type.TOptional<Type.TUnknown>;
}>;
export declare const PluginsSessionActionFailureResultSchema: Type.TObject<{
    ok: Type.TLiteral<false>;
    error: Type.TString;
    code: Type.TOptional<Type.TString>;
    details: Type.TOptional<Type.TUnknown>;
}>;
export declare const PluginsSessionActionResultSchema: Type.TUnion<[Type.TObject<{
    ok: Type.TLiteral<true>;
    result: Type.TOptional<Type.TUnknown>;
    continueAgent: Type.TOptional<Type.TBoolean>;
    reply: Type.TOptional<Type.TUnknown>;
}>, Type.TObject<{
    ok: Type.TLiteral<false>;
    error: Type.TString;
    code: Type.TOptional<Type.TString>;
    details: Type.TOptional<Type.TUnknown>;
}>]>;
