export type SupportRedactionContext = {
    env: NodeJS.ProcessEnv;
    stateDir: string;
};
type RedactSupportStringOptions = {
    maxLength?: number;
    truncationSuffix?: string;
};
export declare function redactPathForSupport(file: string, options: SupportRedactionContext): string;
export declare function redactTextForSupport(value: string): string;
export declare function redactSupportString(value: string, redaction: SupportRedactionContext, options?: RedactSupportStringOptions): string;
export declare function sanitizeSupportSnapshotValue(value: unknown, redaction: SupportRedactionContext, key?: string, depth?: number): unknown;
export declare function sanitizeSupportConfigValue(value: unknown, redaction: SupportRedactionContext, key?: string, depth?: number): unknown;
export {};
