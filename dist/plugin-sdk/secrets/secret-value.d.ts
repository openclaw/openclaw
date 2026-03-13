export type SecretExpectedResolvedValue = "string" | "string-or-object";
export declare function isExpectedResolvedSecretValue(value: unknown, expected: SecretExpectedResolvedValue): boolean;
export declare function hasConfiguredPlaintextSecretValue(value: unknown, expected: SecretExpectedResolvedValue): boolean;
export declare function assertExpectedResolvedSecretValue(params: {
    value: unknown;
    expected: SecretExpectedResolvedValue;
    errorMessage: string;
}): void;
