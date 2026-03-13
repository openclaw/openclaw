export declare const NonEmptyString: import("@sinclair/typebox").TString;
export declare const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
export declare const ChatSendSessionKeyString: import("@sinclair/typebox").TString;
export declare const SessionLabelString: import("@sinclair/typebox").TString;
export declare const InputProvenanceSchema: import("@sinclair/typebox").TObject<{
    kind: import("@sinclair/typebox").TString;
    originSessionId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sourceSessionKey: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sourceChannel: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    sourceTool: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export declare const GatewayClientIdSchema: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"cli" | "webchat" | "webchat-ui" | "openclaw-control-ui" | "gateway-client" | "openclaw-macos" | "openclaw-ios" | "openclaw-android" | "node-host" | "test" | "fingerprint" | "openclaw-probe">[]>;
export declare const GatewayClientModeSchema: import("@sinclair/typebox").TUnion<import("@sinclair/typebox").TLiteral<"node" | "cli" | "ui" | "webchat" | "test" | "backend" | "probe">[]>;
export declare const SecretRefSourceSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"env">, import("@sinclair/typebox").TLiteral<"file">, import("@sinclair/typebox").TLiteral<"exec">]>;
export declare const SecretRefSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"env">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"file">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"exec">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>]>;
export declare const SecretInputSchema: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"env">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"file">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>, import("@sinclair/typebox").TObject<{
    source: import("@sinclair/typebox").TLiteral<"exec">;
    provider: import("@sinclair/typebox").TString;
    id: import("@sinclair/typebox").TString;
}>]>]>;
