type AcceptedEnvOption = {
    key: string;
    description: string;
    value?: string;
    redact?: boolean;
};
export declare function logAcceptedEnvOption(option: AcceptedEnvOption): void;
export declare function normalizeZaiEnv(): void;
export declare function isTruthyEnvValue(value?: string): boolean;
export declare function normalizeEnv(): void;
export {};
