export type SendPolicyOverride = "allow" | "deny";
export declare function normalizeSendPolicyOverride(raw?: string | null): SendPolicyOverride | undefined;
export declare function parseSendPolicyCommand(raw?: string): {
    hasCommand: boolean;
    mode?: SendPolicyOverride | "inherit";
};
