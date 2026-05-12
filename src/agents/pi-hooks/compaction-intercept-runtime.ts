import type { ContextEngine } from "../../context-engine/types.js";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

/**
 * Per-session runtime state for the `compaction-intercept` extension.
 *
 * Modeled after {@link "./compaction-safeguard-runtime.ts"}: a `WeakMap`
 * keyed by SessionManager object identity that carries the resolved
 * {@link ContextEngine} reference for the active session so the extension's
 * `session_before_compact` handler can call `engine.interceptCompaction()`
 * without re-resolving on every event.
 */
export type CompactionInterceptRuntimeValue = {
  contextEngine: ContextEngine;
};

const registry = createSessionManagerRuntimeRegistry<CompactionInterceptRuntimeValue>();

export const setCompactionInterceptRuntime = registry.set;

export const getCompactionInterceptRuntime = registry.get;
