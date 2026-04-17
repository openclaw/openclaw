/**
 * A2A gateway method handlers — plugin-local.
 *
 * These handlers own the gateway RPC surface for a2a.task.* methods.
 * They delegate to the standalone a2a-broker HTTP endpoint directly,
 * keeping zero core imports (extension boundary compliant).
 */
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type {
  A2ATaskCancelParams,
  A2ATaskRequestParams,
  A2ATaskStatusParams,
  A2ATaskUpdateParams,
} from "./gateway-schema.js";
import { validateParams } from "./gateway-validators.js";
import {
  validateA2ATaskCancelParams,
  validateA2ATaskRequestParams,
  validateA2ATaskStatusParams,
  validateA2ATaskUpdateParams,
} from "./gateway-validators.js";
import { a2aError, A2AErrorCodes } from "./plugin-errors.js";

// ── Broker client singleton ──────────────────────────────────
// Lazily initialized from plugin config. Concrete transport will be
// provided by Stream A (standalone-broker-client extraction).
// For now, handlers respond with NOT_FOUND until transport is wired.

type BrokerClient = {
  requestTask(params: A2ATaskRequestParams): Promise<unknown>;
  updateTask(params: A2ATaskUpdateParams): Promise<unknown>;
  cancelTask(params: A2ATaskCancelParams): Promise<unknown>;
  statusTask(params: A2ATaskStatusParams): Promise<unknown>;
};

let _brokerClient: BrokerClient | null | undefined;

function getBrokerClient(_opts: GatewayRequestHandlerOptions): BrokerClient | null {
  if (_brokerClient !== undefined) {
    return _brokerClient;
  }
  // Ownership-swap cut: broker transport not yet wired.
  // Stream A will populate this via the plugin config context.
  _brokerClient = null;
  return _brokerClient;
}

// ── Handlers ─────────────────────────────────────────────────

export async function handleA2ATaskRequest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const check = validateParams(opts.params, validateA2ATaskRequestParams, "a2a.task.request");
  if (!check.valid) {
    opts.respond(false, undefined, check.error);
    return;
  }
  const broker = getBrokerClient(opts);
  if (!broker) {
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.NOT_FOUND, "a2a broker client not initialized"),
    );
    return;
  }
  try {
    const result = await broker.requestTask(check.data);
    opts.respond(true, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.INTERNAL, `a2a.task.request failed: ${msg}`),
    );
  }
}

export async function handleA2ATaskUpdate(opts: GatewayRequestHandlerOptions): Promise<void> {
  const check = validateParams(opts.params, validateA2ATaskUpdateParams, "a2a.task.update");
  if (!check.valid) {
    opts.respond(false, undefined, check.error);
    return;
  }
  const broker = getBrokerClient(opts);
  if (!broker) {
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.NOT_FOUND, "a2a broker client not initialized"),
    );
    return;
  }
  try {
    const result = await broker.updateTask(check.data);
    if (result == null) {
      opts.respond(
        false,
        undefined,
        a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.update.taskId}`),
      );
      return;
    }
    opts.respond(true, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.INVALID_REQUEST, `a2a.task.update failed: ${msg}`),
    );
  }
}

export async function handleA2ATaskCancel(opts: GatewayRequestHandlerOptions): Promise<void> {
  const check = validateParams(opts.params, validateA2ATaskCancelParams, "a2a.task.cancel");
  if (!check.valid) {
    opts.respond(false, undefined, check.error);
    return;
  }
  const broker = getBrokerClient(opts);
  if (!broker) {
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.NOT_FOUND, "a2a broker client not initialized"),
    );
    return;
  }
  try {
    const result = await broker.cancelTask(check.data);
    if (result == null) {
      opts.respond(
        false,
        undefined,
        a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.cancel.taskId}`),
      );
      return;
    }
    opts.respond(true, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.INVALID_REQUEST, `a2a.task.cancel failed: ${msg}`),
    );
  }
}

export async function handleA2ATaskStatus(opts: GatewayRequestHandlerOptions): Promise<void> {
  const check = validateParams(opts.params, validateA2ATaskStatusParams, "a2a.task.status");
  if (!check.valid) {
    opts.respond(false, undefined, check.error);
    return;
  }
  const broker = getBrokerClient(opts);
  if (!broker) {
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.NOT_FOUND, "a2a broker client not initialized"),
    );
    return;
  }
  try {
    const result = await broker.statusTask(check.data);
    if (result == null) {
      opts.respond(
        false,
        undefined,
        a2aError(A2AErrorCodes.NOT_FOUND, `a2a task not found: ${check.data.taskId}`),
      );
      return;
    }
    opts.respond(true, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.respond(
      false,
      undefined,
      a2aError(A2AErrorCodes.INTERNAL, `a2a.task.status failed: ${msg}`),
    );
  }
}

// Exported for testing: allow injecting a broker client.
export function __setBrokerClientForTesting(client: BrokerClient | null): void {
  _brokerClient = client;
}
