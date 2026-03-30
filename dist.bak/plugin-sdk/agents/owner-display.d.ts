import type { OpenClawConfig } from "../config/config.js";
export type OwnerDisplaySetting = {
    ownerDisplay?: "raw" | "hash";
    ownerDisplaySecret?: string;
};
export type OwnerDisplaySecretResolution = {
    config: OpenClawConfig;
    generatedSecret?: string;
};
/**
 * Resolve owner display settings for prompt rendering.
 * Keep auth secrets decoupled from owner hash secrets.
 */
export declare function resolveOwnerDisplaySetting(config?: OpenClawConfig): OwnerDisplaySetting;
/**
 * Ensure hash mode has a dedicated secret.
 * Returns updated config and generated secret when autofill was needed.
 */
export declare function ensureOwnerDisplaySecret(config: OpenClawConfig, generateSecret?: () => string): OwnerDisplaySecretResolution;
