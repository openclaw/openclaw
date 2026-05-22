import { Type } from "typebox";
export declare const execSchema: Type.TObject<{
    command: Type.TString;
    workdir: Type.TOptional<Type.TString>;
    env: Type.TOptional<Type.TRecord<"^.*$", Type.TString>>;
    yieldMs: Type.TOptional<Type.TNumber>;
    background: Type.TOptional<Type.TBoolean>;
    timeout: Type.TOptional<Type.TNumber>;
    pty: Type.TOptional<Type.TBoolean>;
    elevated: Type.TOptional<Type.TBoolean>;
    host: Type.TOptional<Type.TUnsafe<"auto" | "gateway" | "node" | "sandbox">>;
    security: Type.TOptional<Type.TString>;
    ask: Type.TOptional<Type.TString>;
    node: Type.TOptional<Type.TString>;
}>;
export declare const processSchema: Type.TObject<{
    action: Type.TString;
    sessionId: Type.TOptional<Type.TString>;
    data: Type.TOptional<Type.TString>;
    keys: Type.TOptional<Type.TArray<Type.TString>>;
    hex: Type.TOptional<Type.TArray<Type.TString>>;
    literal: Type.TOptional<Type.TString>;
    text: Type.TOptional<Type.TString>;
    bracketed: Type.TOptional<Type.TBoolean>;
    eof: Type.TOptional<Type.TBoolean>;
    offset: Type.TOptional<Type.TNumber>;
    limit: Type.TOptional<Type.TNumber>;
    timeout: Type.TOptional<Type.TNumber>;
}>;
