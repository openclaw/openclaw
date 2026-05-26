export declare const LEGACY_CONFIG_MIGRATIONS: {
    id: string;
    describe: string;
    apply: (raw: Record<string, unknown>, changes: string[]) => void;
}[];
export declare const LEGACY_CONFIG_MIGRATION_RULES: import("../../../config/legacy.shared.ts").LegacyConfigRule[];
