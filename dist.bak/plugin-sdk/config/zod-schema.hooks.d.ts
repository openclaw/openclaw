import { z } from "zod";
export declare const HookMappingSchema: z.ZodOptional<z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    match: z.ZodOptional<z.ZodObject<{
        path: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    action: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"wake">, z.ZodLiteral<"agent">]>>;
    wakeMode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"now">, z.ZodLiteral<"next-heartbeat">]>>;
    name: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
    sessionKey: z.ZodOptional<z.ZodString>;
    messageTemplate: z.ZodOptional<z.ZodString>;
    textTemplate: z.ZodOptional<z.ZodString>;
    deliver: z.ZodOptional<z.ZodBoolean>;
    allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
    channel: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"last">, z.ZodLiteral<"whatsapp">, z.ZodLiteral<"telegram">, z.ZodLiteral<"discord">, z.ZodLiteral<"irc">, z.ZodLiteral<"slack">, z.ZodLiteral<"signal">, z.ZodLiteral<"imessage">, z.ZodLiteral<"msteams">]>>;
    to: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    thinking: z.ZodOptional<z.ZodString>;
    timeoutSeconds: z.ZodOptional<z.ZodNumber>;
    transform: z.ZodOptional<z.ZodObject<{
        module: z.ZodString;
        export: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>>;
export declare const InternalHookHandlerSchema: z.ZodObject<{
    event: z.ZodString;
    module: z.ZodString;
    export: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const InternalHooksSchema: z.ZodOptional<z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    handlers: z.ZodOptional<z.ZodArray<z.ZodObject<{
        event: z.ZodString;
        module: z.ZodString;
        export: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    entries: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$loose>>>;
    load: z.ZodOptional<z.ZodObject<{
        extraDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    installs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        hooks: z.ZodOptional<z.ZodArray<z.ZodString>>;
        source: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">]>;
        spec: z.ZodOptional<z.ZodString>;
        sourcePath: z.ZodOptional<z.ZodString>;
        installPath: z.ZodOptional<z.ZodString>;
        version: z.ZodOptional<z.ZodString>;
        resolvedName: z.ZodOptional<z.ZodString>;
        resolvedVersion: z.ZodOptional<z.ZodString>;
        resolvedSpec: z.ZodOptional<z.ZodString>;
        integrity: z.ZodOptional<z.ZodString>;
        shasum: z.ZodOptional<z.ZodString>;
        resolvedAt: z.ZodOptional<z.ZodString>;
        installedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>>;
export declare const HooksGmailSchema: z.ZodOptional<z.ZodObject<{
    account: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
    topic: z.ZodOptional<z.ZodString>;
    subscription: z.ZodOptional<z.ZodString>;
    pushToken: z.ZodOptional<z.ZodString>;
    hookUrl: z.ZodOptional<z.ZodString>;
    includeBody: z.ZodOptional<z.ZodBoolean>;
    maxBytes: z.ZodOptional<z.ZodNumber>;
    renewEveryMinutes: z.ZodOptional<z.ZodNumber>;
    allowUnsafeExternalContent: z.ZodOptional<z.ZodBoolean>;
    serve: z.ZodOptional<z.ZodObject<{
        bind: z.ZodOptional<z.ZodString>;
        port: z.ZodOptional<z.ZodNumber>;
        path: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    tailscale: z.ZodOptional<z.ZodObject<{
        mode: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"serve">, z.ZodLiteral<"funnel">]>>;
        path: z.ZodOptional<z.ZodString>;
        target: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    model: z.ZodOptional<z.ZodString>;
    thinking: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"off">, z.ZodLiteral<"minimal">, z.ZodLiteral<"low">, z.ZodLiteral<"medium">, z.ZodLiteral<"high">]>>;
}, z.core.$strict>>;
