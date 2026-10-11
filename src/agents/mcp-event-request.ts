import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { VERSION } from "../version.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
import { redactMcpDiagnosticError } from "./mcp-error.js";
import { OpenClawStreamableHTTPClientTransport } from "./mcp-http-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import { resolveMcpTransport } from "./mcp-transport.js";

export const MCP_EVENTS_PROTOCOL_VERSION = "2026-07-28";
export type McpEventRequestMethod =
  | "server/discover"
  | "events/list"
  | "events/subscribe"
  | "events/unsubscribe";

/** Preserve protocol dispositions without exposing remote diagnostic bodies or credentials. */
class McpEventRequestError extends Error {
  constructor(
    readonly code: number,
    readonly reason?: string,
  ) {
    super("MCP Events request failed (code " + code + (reason ? ", reason " + reason : "") + ")");
    this.name = "McpEventRequestError";
  }
}

/**
 * MCP 2 requests have their own metadata and no initialize handshake. Reuse the
 * existing bounded JSON/SSE transport and auth owner rather than a second HTTP client.
 */
export async function requestMcpEvent(params: {
  serverName: string;
  server: unknown;
  method: McpEventRequestMethod;
  params?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  agentDir?: string;
  requesterScope?: SessionMcpRequesterScope;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<unknown> {
  params.assertCurrent();
  const config = resolveMcpTransportConfig(params.serverName, params.server);
  if (config?.kind !== "http" || config.transportType !== "streamable-http") {
    throw new Error("MCP Events requires a configured Streamable HTTP server.");
  }
  const deadline = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
  };
  const resolved = resolveMcpTransport(params.serverName, params.server, {
    cfg: params.cfg,
    agentDir: params.agentDir,
    requesterScope: params.requesterScope,
    requestHeaders: { "Mcp-Method": params.method },
    beforeRequest: assertCurrent,
  });
  if (!resolved || !(resolved.transport instanceof OpenClawStreamableHTTPClientTransport)) {
    throw new Error("MCP Events connection is unavailable for this subscription owner.");
  }
  const transport = resolved.transport;
  transport.setProtocolVersion(MCP_EVENTS_PROTOCOL_VERSION);
  const id = randomUUID();
  const response = createDeferredCore<unknown>();
  // start/authority can fail before the response is awaited.
  void response.promise.catch(() => undefined);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Transport callback contract.
  transport.onmessage = (message) => {
    if (!("id" in message) || message.id !== id) {
      return;
    }
    if ("error" in message) {
      const reason = isRecord(message.error.data) ? message.error.data.reason : undefined;
      response.reject(
        new McpEventRequestError(
          message.error.code,
          typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : undefined,
        ),
      );
    } else if ("result" in message) {
      response.resolve(message.result);
    } else {
      response.reject(new Error("MCP Events received an invalid response."));
    }
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Transport callback contract.
  transport.onerror = (error) => response.reject(error);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Transport callback contract.
  transport.onclose = () => response.reject(new Error("MCP Events connection closed."));
  const onAbort = () => response.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  let sending: Promise<void> | undefined;
  try {
    assertCurrent();
    await transport.start();
    assertCurrent();
    sending = transport.send({
      jsonrpc: "2.0",
      id,
      method: params.method,
      params: {
        ...params.params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_EVENTS_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "openclaw", version: VERSION },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    void sending.catch(response.reject);
    const result = await response.promise;
    assertCurrent();
    return result;
  } catch (error) {
    if (error instanceof McpEventRequestError) {
      throw error;
    }
    // Transport causes can retain credential-bearing URLs; only the sanitized diagnostic may escape.
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error(redactMcpDiagnosticError(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Closing cancels a still-open SSE response after its final JSON-RPC result.
    await transport.close();
    await sending?.catch(() => undefined);
  }
}
