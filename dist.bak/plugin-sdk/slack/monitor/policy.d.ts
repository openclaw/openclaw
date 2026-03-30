export declare function isSlackChannelAllowedByPolicy(params: {
    groupPolicy: "open" | "disabled" | "allowlist";
    channelAllowlistConfigured: boolean;
    channelAllowed: boolean;
}): boolean;
