import type { SubagentRunRecord } from "./subagent-registry.types.js";
export type PersistedSubagentRegistryVersion = 1 | 2;
export declare function resolveSubagentRegistryPath(): string;
export declare function loadSubagentRegistryFromDisk(): Map<string, SubagentRunRecord>;
export declare function saveSubagentRegistryToDisk(runs: Map<string, SubagentRunRecord>): void;
