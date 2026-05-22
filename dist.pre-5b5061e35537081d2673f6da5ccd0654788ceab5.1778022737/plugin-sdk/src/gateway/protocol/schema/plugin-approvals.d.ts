import { Type } from "typebox";
export declare const PluginApprovalRequestParamsSchema: Type.TObject<{
    pluginId: Type.TOptional<Type.TString>;
    title: Type.TString;
    description: Type.TString;
    severity: Type.TOptional<Type.TString>;
    toolName: Type.TOptional<Type.TString>;
    toolCallId: Type.TOptional<Type.TString>;
    agentId: Type.TOptional<Type.TString>;
    sessionKey: Type.TOptional<Type.TString>;
    turnSourceChannel: Type.TOptional<Type.TString>;
    turnSourceTo: Type.TOptional<Type.TString>;
    turnSourceAccountId: Type.TOptional<Type.TString>;
    turnSourceThreadId: Type.TOptional<Type.TUnion<[Type.TString, Type.TNumber]>>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    twoPhase: Type.TOptional<Type.TBoolean>;
}>;
export declare const PluginApprovalResolveParamsSchema: Type.TObject<{
    id: Type.TString;
    decision: Type.TString;
}>;
