export type LegacyConfigRule = {
    path: string[];
    message: string;
    match?: (value: unknown, root: Record<string, unknown>) => boolean;
};
export type LegacyConfigMigration = {
    id: string;
    describe: string;
    apply: (raw: Record<string, unknown>, changes: string[]) => void;
};
import { isRecord } from "../utils.js";
export { isRecord };
export declare const getRecord: (value: unknown) => Record<string, unknown> | null;
export declare const ensureRecord: (root: Record<string, unknown>, key: string) => Record<string, unknown>;
export declare const mergeMissing: (target: Record<string, unknown>, source: Record<string, unknown>) => void;
export declare const mapLegacyAudioTranscription: (value: unknown) => Record<string, unknown> | null;
export declare const getAgentsList: (agents: Record<string, unknown> | null) => any[];
export declare const resolveDefaultAgentIdFromRaw: (raw: Record<string, unknown>) => string;
export declare const ensureAgentEntry: (list: unknown[], id: string) => Record<string, unknown>;
