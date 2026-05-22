export type SecretRefSource = "env" | "file" | "exec";
export type SecretRef = {
    source: SecretRefSource;
    provider: string;
    id: string;
};
export declare function hasConfiguredSecretInput(value: unknown): boolean;
export declare function resolveSecretInputRef(value: unknown): SecretRef | null;
export declare function normalizeResolvedSecretInputString(params: {
    value: unknown;
    path: string;
}): string | undefined;
export declare function normalizeEnvSecretInputString(value: unknown): string | undefined;
