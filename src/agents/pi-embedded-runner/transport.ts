import { streamSimple } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";

export type StreamFnWrapper = (fn: StreamFn) => StreamFn;

export type TransportOptions = {
  /** Base stream function. Defaults to `streamSimple` (direct LLM calls). */
  base?: StreamFn;
  /** Wrappers applied in order (first wrapper is innermost). */
  wrappers?: StreamFnWrapper[];
};

/**
 * Resolve the final stream function by composing a base with optional wrappers.
 *
 * The wrapping chain applies wrappers in array order — each wrapper receives
 * the previously wrapped function. This matches the existing pattern in
 * attempt.ts where cacheTrace wraps first, then anthropicPayloadLogger wraps
 * the result.
 *
 * Future transport modes (proxy, OpenCode backend) can be added by passing
 * a different `base` without changing the wrapping logic.
 */
export function resolveStreamFn(options: TransportOptions = {}): StreamFn {
  let fn: StreamFn = options.base ?? streamSimple;
  if (options.wrappers) {
    for (const wrapper of options.wrappers) {
      fn = wrapper(fn);
    }
  }
  return fn;
}
