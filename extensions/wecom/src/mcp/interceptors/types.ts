/**
 * MCP Call Interceptor Type Definitions
 *
 * Interceptors inject special logic before and after tools/call invocations,
 * such as modifying timeout config or transforming response results,
 * avoiding piling up if/else in tool.ts.
 */

import type { SendJsonRpcOptions } from "../transport.js";

// ============================================================================
// Type Definitions
// ============================================================================

/** Context of an MCP call invocation */
export interface CallContext {
  /** Account ID used to scope the WSClient and MCP cache */
  accountId: string;
  /** MCP category, corresponding to mcpConfig keys, e.g., doc, contact */
  category: string;
  /** MCP method name being called */
  method: string;
  /** Parameters for the MCP method call */
  args: Record<string, unknown>;
}

/**
 * Options returned by beforeCall
 *
 * Extends SendJsonRpcOptions to allow interceptors to replace args before the call (e.g., read request body from local file).
 */
export interface BeforeCallOptions extends SendJsonRpcOptions {
  /** Replaced args (optional; if not returned, original args are used) */
  args?: Record<string, unknown>;
}

/**
 * Call Interceptor Interface
 *
 * Each interceptor uses match to determine if it applies to the current call.
 * When active, it can inject logic before (beforeCall) and after (afterCall) the call.
 */
export interface CallInterceptor {
  /** Interceptor name (used for logging) */
  name: string;

  /**
   * Determine if this interceptor applies to the current call
   *
   * beforeCall / afterCall are only executed when this returns true
   */
  match(ctx: CallContext): boolean;

  /**
   * Modify request options and parameters before sendJsonRpc call (optional)
   *
   * e.g., get_msg_media needs extended timeout,
   * e.g., smartpage_create needs to read request body from local file to replace args.
   * Returned options are merged with other interceptors' results (timeoutMs takes max, args: later overwrites earlier).
   */
  beforeCall?(ctx: CallContext): BeforeCallOptions | Promise<BeforeCallOptions> | undefined;

  /**
   * Process/transform results after sendJsonRpc returns (optional)
   *
   * Multiple interceptors' afterCall execute sequentially in pipeline fashion;
   * the return value of the previous becomes the input of the next.
   */
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- intentional explicit union member
  afterCall?(ctx: CallContext, result: unknown): Promise<unknown> | unknown;
}
