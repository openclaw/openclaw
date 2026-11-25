import { SdkHttpError, type Client, type Transport } from "@modelcontextprotocol/client";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { logWarn } from "../logger.js";
import { settlesWithin } from "../shared/settle-within.js";
import {
  McpSseSessionExpiredError,
  OpenClawSSEClientTransport,
  OpenClawStreamableHTTPClientTransport,
} from "./mcp-http-transport.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

type LifecycleSession = {
  client: Pick<Client, "close">;
  transport: Transport & { terminateSession?: () => Promise<void> };
  transportType: "stdio" | "sse" | "streamable-http";
  detachStderr?: () => void;
  onCleanupError?: (error: unknown) => void;
};

class McpClientConnectTimeoutError extends Error {}

/** Matches an expired HTTP session without treating stateless HTTP 404s as expiration. */
export function isMcpHttpSessionExpired(
  session: Pick<LifecycleSession, "transport" | "transportType">,
  error: unknown,
): boolean {
  if (session.transportType === "sse") {
    return (
      session.transport instanceof OpenClawSSEClientTransport &&
      error instanceof McpSseSessionExpiredError
    );
  }
  return (
    session.transportType === "streamable-http" &&
    session.transport instanceof OpenClawStreamableHTTPClientTransport &&
    session.transport.sessionId !== undefined &&
    error instanceof SdkHttpError &&
    error.status === 404
  );
}

export async function connectMcpClient(params: {
  client: Pick<Client, "connect" | "close">;
  transport: Transport;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline]) : deadline;
  try {
    await racePromiseWithAbortSignal(
      (async () => {
        const { client } = params;
        const close = client.close;
        client.close = () => {
          const closing = close.call(client);
          // SDK initialization discards this promise; preserve rejection for awaited callers.
          void closing.catch(() => recordAgentCleanupFailure());
          return closing;
        };
        try {
          await client.connect(params.transport, {
            signal,
            timeout: params.timeoutMs,
            maxTotalTimeout: params.timeoutMs,
          });
        } finally {
          // A deadline can win the outer race before SDK initialization actually settles.
          client.close = close;
        }
      })(),
      signal,
      () => (signal.reason instanceof Error ? signal.reason : new Error("MCP startup aborted")),
    );
  } catch (error) {
    const { isMcpRequestTimeoutError } = await import("./mcp-error.js");
    if (deadline.aborted || isMcpRequestTimeoutError(error)) {
      await disposeMcpClient(
        {
          client: params.client,
          transport: params.transport,
          transportType:
            params.transport instanceof OpenClawStdioClientTransport
              ? "stdio"
              : params.transport instanceof OpenClawStreamableHTTPClientTransport
                ? "streamable-http"
                : "sse",
        },
        Math.min(params.timeoutMs, 1_000),
      );
      throw new McpClientConnectTimeoutError(
        `MCP server connection timed out after ${params.timeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Single-flight connection state remains on the calling session owner. */
export async function ensureMcpSessionConnected(
  session: {
    client: Pick<Client, "connect" | "close">;
    transport: Transport;
    serverName: string;
    retiring: boolean;
    connected: boolean;
    connectPromise?: Promise<void>;
  },
  connectionTimeoutMs: number,
): Promise<void> {
  if (session.retiring) {
    throw new Error(`bundle-mcp server "${session.serverName}" is retiring`);
  }
  if (session.connected) {
    return;
  }
  session.connectPromise ??= connectMcpClient({
    client: session.client,
    transport: session.transport,
    timeoutMs: connectionTimeoutMs,
  })
    .catch((error: unknown) => {
      if (error instanceof McpClientConnectTimeoutError) {
        throw new Error(
          `MCP server "${session.serverName}" timed out: did not complete initialize within ${connectionTimeoutMs / 1_000}s`,
          { cause: error },
        );
      }
      throw error;
    })
    .then(() => {
      session.connected = true;
    })
    .finally(() => {
      session.connectPromise = undefined;
    });
  await session.connectPromise;
}

export async function disposeMcpClient(
  session: LifecycleSession,
  timeoutMs = 5_000,
): Promise<"closed" | "uncertain"> {
  let failed = false;
  const markFailed = () => {
    failed = true;
    recordAgentCleanupFailure();
  };
  const ignoreCloseFailure = async (close: () => void | PromiseLike<unknown>) => {
    try {
      await close();
    } catch (error) {
      const firstFailure = !failed;
      markFailed();
      if (firstFailure) {
        try {
          session.onCleanupError?.(error);
        } catch {
          // Diagnostic observers cannot interrupt resource cleanup.
        }
      }
    }
  };
  try {
    const graceful = (async () => {
      if (session.transportType === "streamable-http") {
        // Remote DELETE is best effort; local close still owns replacement safety.
        try {
          await session.transport.terminateSession?.();
        } catch {
          logWarn(
            "bundle-mcp: remote session termination was not confirmed; continuing local cleanup",
          );
        }
      }
      await ignoreCloseFailure(() => session.transport.close());
      await ignoreCloseFailure(() => session.client.close());
    })();
    const closed = await settlesWithin(graceful, timeoutMs);
    if (closed) {
      return failed ? "uncertain" : "closed";
    }
    // Stdio owns a process group; force it dead before reporting completion.
    const { transport } = session;
    const closeTransport =
      session.transportType === "stdio" && transport instanceof OpenClawStdioClientTransport
        ? () => transport.forceClose()
        : () => transport.close();
    const forced = await settlesWithin(
      Promise.all([
        graceful,
        ignoreCloseFailure(closeTransport),
        ignoreCloseFailure(() => session.client.close()),
      ]),
      timeoutMs,
    );
    if (!forced) {
      markFailed();
    }
    return failed ? "uncertain" : "closed";
  } finally {
    // Shutdown itself may emit the last diagnostic; detach only after it settles.
    session.detachStderr?.();
  }
}
