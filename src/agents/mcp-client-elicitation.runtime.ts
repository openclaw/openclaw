import {
  ProtocolError,
  ProtocolErrorCode,
  type Client,
  type ClientContext,
} from "@modelcontextprotocol/client";
import { ElicitResultSchema } from "@modelcontextprotocol/core";
import { z } from "zod";
import {
  captureMcpClientElicitation,
  type McpElicitationHandler,
} from "./mcp-client-elicitation.js";

/** The SDK transport callback does not inherit the calling tool's async scope. */
export function bindMcpClientElicitation(client: Client) {
  const active = new Set<{
    handler?: McpElicitationHandler;
    signal: AbortSignal;
    holdForHumanInput?: () => () => void;
  }>();
  for (const method of ["elicitation/create", "openai/elicitation/create"] as const) {
    const handle = async (params: Record<string, unknown>, extra: ClientContext) => {
      // MCP 2025-11-25 does not carry a portable parent-call id. Never route a
      // server question to a different collaborator when requests overlap.
      const call = active.size === 1 ? active.values().next().value : undefined;
      if (!call?.handler) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          "MCP elicitation has no unambiguous active requester",
        );
      }
      const signal = AbortSignal.any([call.signal, extra.mcpReq.signal]);
      signal.throwIfAborted();
      const release = call.holdForHumanInput?.();
      try {
        const result = await call.handler({
          method,
          requestId: extra.mcpReq.id,
          params,
          signal,
        });
        signal.throwIfAborted();
        if (!active.has(call)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            "MCP elicitation requester expired",
          );
        }
        return result;
      } finally {
        release?.();
      }
    };
    if (method === "elicitation/create") {
      client.setRequestHandler(method, async (request, extra) =>
        ElicitResultSchema.parse(await handle(request.params, extra)),
      );
    } else {
      client.setRequestHandler(method, { params: z.record(z.string(), z.unknown()) }, handle);
    }
  }
  return async <T>(
    signal: AbortSignal,
    run: () => Promise<T>,
    holdForHumanInput?: () => () => void,
  ): Promise<T> => {
    const call = {
      handler: captureMcpClientElicitation()?.handle,
      signal,
      holdForHumanInput,
    };
    active.add(call);
    try {
      return await run();
    } finally {
      active.delete(call);
    }
  };
}
