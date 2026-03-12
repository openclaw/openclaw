import type { AcpSessionRuntimeOptions, SessionAcpMeta } from "../../config/sessions/types.js";
export declare function validateRuntimeModeInput(rawMode: unknown): string;
export declare function validateRuntimeModelInput(rawModel: unknown): string;
export declare function validateRuntimePermissionProfileInput(rawProfile: unknown): string;
export declare function validateRuntimeCwdInput(rawCwd: unknown): string;
export declare function validateRuntimeTimeoutSecondsInput(rawTimeout: unknown): number;
export declare function parseRuntimeTimeoutSecondsInput(rawTimeout: unknown): number;
export declare function validateRuntimeConfigOptionInput(rawKey: unknown, rawValue: unknown): {
    key: string;
    value: string;
};
export declare function validateRuntimeOptionPatch(patch: Partial<AcpSessionRuntimeOptions> | undefined): Partial<AcpSessionRuntimeOptions>;
export declare function normalizeText(value: unknown): string | undefined;
export declare function normalizeRuntimeOptions(options: AcpSessionRuntimeOptions | undefined): AcpSessionRuntimeOptions;
export declare function mergeRuntimeOptions(params: {
    current?: AcpSessionRuntimeOptions;
    patch?: Partial<AcpSessionRuntimeOptions>;
}): AcpSessionRuntimeOptions;
export declare function resolveRuntimeOptionsFromMeta(meta: SessionAcpMeta): AcpSessionRuntimeOptions;
export declare function runtimeOptionsEqual(a: AcpSessionRuntimeOptions | undefined, b: AcpSessionRuntimeOptions | undefined): boolean;
export declare function buildRuntimeControlSignature(options: AcpSessionRuntimeOptions): string;
export declare function buildRuntimeConfigOptionPairs(options: AcpSessionRuntimeOptions): Array<[string, string]>;
export declare function inferRuntimeOptionPatchFromConfigOption(key: string, value: string): Partial<AcpSessionRuntimeOptions>;
