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
