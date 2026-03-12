import type { OpenClawConfig } from "./types.js";
/**
 * Normalize "~" paths in path-ish config fields.
 *
 * Goal: accept `~/...` consistently across config file + env overrides, while
 * keeping the surface area small and predictable.
 */
export declare function normalizeConfigPaths(cfg: OpenClawConfig): OpenClawConfig;
