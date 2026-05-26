import type { LegacyConfigRule } from "./legacy.shared.js";
import type { LegacyConfigIssue } from "./types.js";
export declare function findLegacyConfigIssues(raw: unknown, sourceRaw?: unknown, extraRules?: LegacyConfigRule[], _touchedPaths?: ReadonlyArray<ReadonlyArray<string>>): LegacyConfigIssue[];
