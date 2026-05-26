import { z } from "zod";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
export type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";
export declare function isPluginOwnedChannelHintPath(path: string): boolean;
export { isSensitiveConfigPath };
export declare function buildBaseHints(): ConfigUiHints;
export declare function applySensitiveHints(hints: ConfigUiHints, allowedKeys?: ReadonlySet<string>): ConfigUiHints;
export declare function applySensitiveUrlHints(hints: ConfigUiHints, allowedKeys?: ReadonlySet<string>): ConfigUiHints;
export declare function collectMatchingSchemaPaths(schema: z.ZodType, path: string, matchesPath: (path: string) => boolean, paths?: Set<string>): Set<string>;
export declare function mapSensitivePaths(schema: z.ZodType, path: string, hints: ConfigUiHints): ConfigUiHints;
/** @internal */
export declare const __test__: {
    collectMatchingSchemaPaths: typeof collectMatchingSchemaPaths;
    mapSensitivePaths: typeof mapSensitivePaths;
};
