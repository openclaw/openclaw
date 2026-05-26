import { Type } from "typebox";
export declare const ArtifactQueryParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
}>;
export declare const ArtifactGetParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    artifactId: Type.TString;
}>;
export declare const ArtifactSummarySchema: Type.TObject<{
    id: Type.TString;
    type: Type.TString;
    title: Type.TString;
    mimeType: Type.TOptional<Type.TString>;
    sizeBytes: Type.TOptional<Type.TInteger>;
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    messageSeq: Type.TOptional<Type.TInteger>;
    source: Type.TOptional<Type.TString>;
    download: Type.TObject<{
        mode: Type.TUnion<[Type.TLiteral<"bytes">, Type.TLiteral<"url">, Type.TLiteral<"unsupported">]>;
    }>;
}>;
export declare const ArtifactsListParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
}>;
export declare const ArtifactsListResultSchema: Type.TObject<{
    artifacts: Type.TArray<Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        title: Type.TString;
        mimeType: Type.TOptional<Type.TString>;
        sizeBytes: Type.TOptional<Type.TInteger>;
        sessionKey: Type.TOptional<Type.TString>;
        runId: Type.TOptional<Type.TString>;
        taskId: Type.TOptional<Type.TString>;
        messageSeq: Type.TOptional<Type.TInteger>;
        source: Type.TOptional<Type.TString>;
        download: Type.TObject<{
            mode: Type.TUnion<[Type.TLiteral<"bytes">, Type.TLiteral<"url">, Type.TLiteral<"unsupported">]>;
        }>;
    }>>;
}>;
export declare const ArtifactsGetParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    artifactId: Type.TString;
}>;
export declare const ArtifactsGetResultSchema: Type.TObject<{
    artifact: Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        title: Type.TString;
        mimeType: Type.TOptional<Type.TString>;
        sizeBytes: Type.TOptional<Type.TInteger>;
        sessionKey: Type.TOptional<Type.TString>;
        runId: Type.TOptional<Type.TString>;
        taskId: Type.TOptional<Type.TString>;
        messageSeq: Type.TOptional<Type.TInteger>;
        source: Type.TOptional<Type.TString>;
        download: Type.TObject<{
            mode: Type.TUnion<[Type.TLiteral<"bytes">, Type.TLiteral<"url">, Type.TLiteral<"unsupported">]>;
        }>;
    }>;
}>;
export declare const ArtifactsDownloadParamsSchema: Type.TObject<{
    sessionKey: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    taskId: Type.TOptional<Type.TString>;
    artifactId: Type.TString;
}>;
export declare const ArtifactsDownloadResultSchema: Type.TObject<{
    artifact: Type.TObject<{
        id: Type.TString;
        type: Type.TString;
        title: Type.TString;
        mimeType: Type.TOptional<Type.TString>;
        sizeBytes: Type.TOptional<Type.TInteger>;
        sessionKey: Type.TOptional<Type.TString>;
        runId: Type.TOptional<Type.TString>;
        taskId: Type.TOptional<Type.TString>;
        messageSeq: Type.TOptional<Type.TInteger>;
        source: Type.TOptional<Type.TString>;
        download: Type.TObject<{
            mode: Type.TUnion<[Type.TLiteral<"bytes">, Type.TLiteral<"url">, Type.TLiteral<"unsupported">]>;
        }>;
    }>;
    encoding: Type.TOptional<Type.TLiteral<"base64">>;
    data: Type.TOptional<Type.TString>;
    url: Type.TOptional<Type.TString>;
}>;
