import { Type } from "typebox";
export declare const EnvironmentStatusSchema: Type.TString;
export declare const EnvironmentSummarySchema: Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    label: Type.TOptional<Type.TString>;
    status: Type.TString;
    capabilities: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export declare const EnvironmentsListParamsSchema: Type.TObject<{}>;
export declare const EnvironmentsListResultSchema: Type.TObject<{
    environments: Type.TArray<Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        label: Type.TOptional<Type.TString>;
        status: Type.TString;
        capabilities: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
}>;
export declare const EnvironmentsStatusParamsSchema: Type.TObject<{
    environmentId: Type.TString;
}>;
export declare const EnvironmentsStatusResultSchema: Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    label: Type.TOptional<Type.TString>;
    status: Type.TString;
    capabilities: Type.TOptional<Type.TArray<Type.TString>>;
}>;
