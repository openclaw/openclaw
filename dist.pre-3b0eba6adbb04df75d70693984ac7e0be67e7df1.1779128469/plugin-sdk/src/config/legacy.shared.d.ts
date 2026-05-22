export type LegacyConfigRule = {
    path: string[];
    message: string;
    match?: (value: unknown, root: Record<string, unknown>) => boolean;
    requireSourceLiteral?: boolean;
};
type LegacyConfigMigration = {
    id: string;
    describe: string;
    apply: (raw: Record<string, unknown>, changes: string[]) => void;
};
export type LegacyConfigMigrationSpec = LegacyConfigMigration & {
    legacyRules?: LegacyConfigRule[];
};
export declare const getRecord: (value: unknown) => Record<string, unknown> | null;
export declare const ensureRecord: (root: Record<string, unknown>, key: string) => Record<string, unknown>;
export declare const mergeMissing: (target: Record<string, unknown>, source: Record<string, unknown>) => void;
export declare const mapLegacyAudioTranscription: (value: unknown) => Record<string, unknown> | null;
export declare const defineLegacyConfigMigration: (migration: LegacyConfigMigrationSpec) => LegacyConfigMigrationSpec;
export {};
