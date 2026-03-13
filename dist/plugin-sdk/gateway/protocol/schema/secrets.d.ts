import { type Static } from "@sinclair/typebox";
export declare const SecretsReloadParamsSchema: import("@sinclair/typebox").TObject<{}>;
export declare const SecretsResolveParamsSchema: import("@sinclair/typebox").TObject<{
    commandName: import("@sinclair/typebox").TString;
    targetIds: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
}>;
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;
export declare const SecretsResolveAssignmentSchema: import("@sinclair/typebox").TObject<{
    path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    pathSegments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
    value: import("@sinclair/typebox").TUnknown;
}>;
export declare const SecretsResolveResultSchema: import("@sinclair/typebox").TObject<{
    ok: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    assignments: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TObject<{
        path: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        pathSegments: import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>;
        value: import("@sinclair/typebox").TUnknown;
    }>>>;
    diagnostics: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
    inactiveRefPaths: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
}>;
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
