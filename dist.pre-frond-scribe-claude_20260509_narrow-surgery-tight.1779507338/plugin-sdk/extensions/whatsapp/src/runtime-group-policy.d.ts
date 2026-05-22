export declare function resolveWhatsAppRuntimeGroupPolicy(params: {
    providerConfigPresent: boolean;
    groupPolicy?: "open" | "allowlist" | "disabled";
    defaultGroupPolicy?: "open" | "allowlist" | "disabled";
}): {
    groupPolicy: "open" | "allowlist" | "disabled";
    providerMissingFallbackApplied: boolean;
};
