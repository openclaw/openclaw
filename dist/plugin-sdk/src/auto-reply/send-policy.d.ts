type SendPolicyOverride = "allow" | "deny";
export declare function parseSendPolicyCommand(raw?: string): {
    hasCommand: boolean;
    mode?: SendPolicyOverride | "inherit";
};
export {};
