export type PluginSdkDocCategory = "channel" | "core" | "legacy" | "provider" | "runtime" | "utilities";
export declare const pluginSdkDocMetadata: {
    readonly index: {
        readonly category: "legacy";
    };
    readonly "channel-runtime": {
        readonly category: "legacy";
    };
    readonly core: {
        readonly category: "core";
    };
    readonly "approval-runtime": {
        readonly category: "runtime";
    };
    readonly "approval-auth-runtime": {
        readonly category: "runtime";
    };
    readonly "approval-client-runtime": {
        readonly category: "runtime";
    };
    readonly "approval-delivery-runtime": {
        readonly category: "runtime";
    };
    readonly "approval-native-runtime": {
        readonly category: "runtime";
    };
    readonly "approval-reply-runtime": {
        readonly category: "runtime";
    };
    readonly "plugin-entry": {
        readonly category: "core";
    };
    readonly "plugin-test-api": {
        readonly category: "utilities";
    };
    readonly "plugin-test-contracts": {
        readonly category: "utilities";
    };
    readonly "plugin-test-runtime": {
        readonly category: "utilities";
    };
    readonly "channel-actions": {
        readonly category: "channel";
    };
    readonly "channel-config-schema": {
        readonly category: "channel";
    };
    readonly "channel-config-schema-legacy": {
        readonly category: "channel";
    };
    readonly "channel-contract": {
        readonly category: "channel";
    };
    readonly "channel-contract-testing": {
        readonly category: "channel";
    };
    readonly "channel-pairing": {
        readonly category: "channel";
    };
    readonly "channel-reply-pipeline": {
        readonly category: "channel";
    };
    readonly "channel-setup": {
        readonly category: "channel";
    };
    readonly "command-auth": {
        readonly category: "channel";
    };
    readonly zalouser: {
        readonly category: "channel";
    };
    readonly "command-status": {
        readonly category: "channel";
    };
    readonly "command-status-runtime": {
        readonly category: "runtime";
    };
    readonly "secret-input": {
        readonly category: "channel";
    };
    readonly "webhook-ingress": {
        readonly category: "channel";
    };
    readonly "provider-onboard": {
        readonly category: "provider";
    };
    readonly "provider-selection-runtime": {
        readonly category: "provider";
    };
    readonly "runtime-store": {
        readonly category: "runtime";
    };
    readonly "allow-from": {
        readonly category: "utilities";
    };
    readonly "reply-payload": {
        readonly category: "utilities";
    };
    readonly testing: {
        readonly category: "utilities";
    };
    readonly "channel-test-helpers": {
        readonly category: "utilities";
    };
    readonly "agent-runtime-test-contracts": {
        readonly category: "utilities";
    };
    readonly "channel-target-testing": {
        readonly category: "utilities";
    };
    readonly "provider-test-contracts": {
        readonly category: "utilities";
    };
    readonly "provider-http-test-mocks": {
        readonly category: "utilities";
    };
    readonly "test-env": {
        readonly category: "utilities";
    };
    readonly "test-fixtures": {
        readonly category: "utilities";
    };
};
export type PluginSdkDocEntrypoint = keyof typeof pluginSdkDocMetadata;
export declare function resolvePluginSdkDocImportSpecifier(entrypoint: PluginSdkDocEntrypoint): string;
