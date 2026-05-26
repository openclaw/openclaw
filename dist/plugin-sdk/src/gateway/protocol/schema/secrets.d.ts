import { Type, type Static } from "typebox";
export declare const SecretsReloadParamsSchema: Type.TObject<{}>;
export declare const SecretsResolveParamsSchema: Type.TObject<{
    commandName: Type.TString;
    targetIds: Type.TArray<Type.TString>;
    allowedPaths: Type.TOptional<Type.TArray<Type.TString>>;
    forcedActivePaths: Type.TOptional<Type.TArray<Type.TString>>;
    optionalActivePaths: Type.TOptional<Type.TArray<Type.TString>>;
    providerOverrides: Type.TOptional<Type.TObject<{
        webSearch: Type.TOptional<Type.TString>;
        webFetch: Type.TOptional<Type.TString>;
    }>>;
}>;
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;
export declare const SecretsResolveAssignmentSchema: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    pathSegments: Type.TArray<Type.TString>;
    value: Type.TUnknown;
}>;
export declare const SecretsResolveResultSchema: Type.TObject<{
    ok: Type.TOptional<Type.TBoolean>;
    assignments: Type.TOptional<Type.TArray<Type.TObject<{
        path: Type.TOptional<Type.TString>;
        pathSegments: Type.TArray<Type.TString>;
        value: Type.TUnknown;
    }>>>;
    diagnostics: Type.TOptional<Type.TArray<Type.TString>>;
    inactiveRefPaths: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
