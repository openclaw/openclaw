import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { n as ContinuationRuntimeConfig } from "./types-DlyOjMq5.js";

//#region src/auto-reply/continuation/config.d.ts
/**
 * Resolve the continuation runtime config from the gateway config.
 *
 * Called at each enforcement point (scheduling, chain check, cost check, etc.)
 * so hot-reloaded config values take effect at the next decision.
 */
declare function resolveContinuationRuntimeConfig(cfg?: OpenClawConfig): ContinuationRuntimeConfig;
//#endregion
export { resolveContinuationRuntimeConfig as t };