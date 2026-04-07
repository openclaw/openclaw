/**
 * MCP call interceptor registry and dispatch entry
 *
 * All call interceptors are registered here and executed in registration order.
 * To add a new interceptor, simply:
 *   1. Create a new file in the interceptors/ directory and implement the CallInterceptor interface
 *   2. Register it in the interceptors array below
 *
 * No changes are required in tool.ts's handleCall.
 */

import type { SendJsonRpcOptions } from "../transport.js";
import { bizErrorInterceptor } from "./biz-error.js";
import { mediaInterceptor } from "./msg-media.js";
import { smartpageCreateInterceptor } from "./smartpage-create.js";
import { smartpageExportInterceptor } from "./smartpage-export.js";
import type { CallContext, CallInterceptor, BeforeCallOptions } from "./types.js";

export type { CallContext, CallInterceptor, BeforeCallOptions } from "./types.js";

// ============================================================================
// Interceptor registry (executed in registration order)
// ============================================================================

const interceptors: CallInterceptor[] = [
  bizErrorInterceptor, // Business error code check (applies to all calls)
  mediaInterceptor, // get_msg_media base64 interception
  smartpageCreateInterceptor, // smartpage_create local file loading
  smartpageExportInterceptor, // smartpage_get_export_result content → local file
];

// ============================================================================
// Dispatch API
// ============================================================================

/** Return value of resolveBeforeCall */
export interface ResolvedBeforeCall {
  /** Merged sendJsonRpc options (for example, timeout settings) */
  options?: SendJsonRpcOptions;
  /** Replaced args (for example, a request body loaded from a local file) */
  args?: Record<string, unknown>;
}

/**
 * Collect matching beforeCall configs and return the merged result
 *
 * Merge strategy:
 * - timeoutMs: use the largest value returned by any interceptor
 * - args: later-registered interceptors override earlier ones (usually only one interceptor returns args for a given call)
 */
export async function resolveBeforeCall(ctx: CallContext): Promise<ResolvedBeforeCall> {
  let mergedTimeoutMs: number | undefined;
  let mergedArgs: Record<string, unknown> | undefined;

  for (const interceptor of interceptors) {
    if (!interceptor.match(ctx) || !interceptor.beforeCall) {
      continue;
    }

    const opts = await interceptor.beforeCall(ctx);
    if (opts?.timeoutMs !== undefined) {
      mergedTimeoutMs =
        mergedTimeoutMs === undefined ? opts.timeoutMs : Math.max(mergedTimeoutMs, opts.timeoutMs);
    }
    if (opts?.args !== undefined) {
      mergedArgs = opts.args;
    }
  }

  return {
    options: mergedTimeoutMs !== undefined ? { timeoutMs: mergedTimeoutMs } : undefined,
    args: mergedArgs,
  };
}

/**
 * Execute matching afterCall interceptors sequentially, passing result through pipeline
 *
 * The return value of the previous interceptor becomes the input of the next.
 * Interceptors that don't need to modify result should return it as-is.
 */
export async function runAfterCall(ctx: CallContext, result: unknown): Promise<unknown> {
  let current = result;

  for (const interceptor of interceptors) {
    if (!interceptor.match(ctx) || !interceptor.afterCall) {
      continue;
    }
    current = await interceptor.afterCall(ctx, current);
  }

  return current;
}
