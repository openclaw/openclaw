/**
 * Continuation runtime configuration resolution.
 *
 * Reads from `agents.defaults.continuation` in the gateway config.
 * Values are clamped to safe ranges. Hot-reloadable — reads happen at each
 * enforcement point, not at process start.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContinuationRuntimeConfig } from "./types.js";
/**
 * Resolve the continuation runtime config from the gateway config.
 *
 * Called at each enforcement point (scheduling, chain check, cost check, etc.)
 * so hot-reloaded config values take effect at the next decision.
 */
export declare function resolveContinuationRuntimeConfig(cfg?: OpenClawConfig): ContinuationRuntimeConfig;
/**
 * Convenience: resolve just the max delegates per turn.
 */
export declare function resolveMaxDelegatesPerTurn(cfg?: OpenClawConfig): number;
/**
 * Clamp a raw delay value to the configured [minDelayMs, maxDelayMs] range.
 */
export declare function clampDelayMs(rawMs: number | undefined, config: ContinuationRuntimeConfig): number;
