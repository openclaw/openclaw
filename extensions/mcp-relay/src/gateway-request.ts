import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RelayError } from "./protocol.js";

export type GatewayRequest = (
  ...args: Parameters<PluginRuntime["gateway"]["request"]>
) => Promise<unknown>;

function deadlineError() {
  return new RelayError(
    "timeout",
    "This request reached its time limit. Check the conversation in OpenClaw before retrying.",
  );
}

export function createDeadlineGatewayRequest(
  request: GatewayRequest,
  deadline: number,
  now: () => number,
): GatewayRequest {
  return async (method, params, options) => {
    const startedAt = now();
    const remaining = Math.floor(deadline - startedAt);
    if (remaining <= 0) {
      throw deadlineError();
    }
    const timeoutMs = Math.min(options?.timeoutMs ?? remaining, remaining);
    const rpcDeadline = startedAt + timeoutMs;
    // Let agent.wait publish its observation before the surrounding RPC timer wins.
    const boundedParams =
      method === "agent.wait" && typeof params?.timeoutMs === "number"
        ? { ...params, timeoutMs: Math.min(params.timeoutMs, Math.max(0, timeoutMs - 1_000)) }
        : params;
    try {
      return await request(method, boundedParams, { ...options, timeoutMs });
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      const code = isRecord(error) ? error.code : undefined;
      if (
        code === "CLIENT_TIMEOUT" ||
        code === "AGENT_TIMEOUT" ||
        (code === undefined && error instanceof Error && now() >= rpcDeadline)
      ) {
        throw deadlineError();
      }
      throw error;
    }
  };
}
