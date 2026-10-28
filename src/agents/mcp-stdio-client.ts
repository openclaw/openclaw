import {
  Protocol,
  ProtocolError,
  type BaseContext,
  type RequestOptions,
  type Transport,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { ResultSchema } from "@modelcontextprotocol/core";
import { materializeErrorStack } from "../infra/error-graph-internal.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import type { ProcessCleanupResult } from "../process/supervisor/types.js";
import { McpStdioFrameDecoder, McpStdioFrameError } from "./mcp-stdio-frame-decoder.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

const MAX_STDERR_BYTES = 32 * 1024;

export type McpStdioClientParams = {
  command: string;
  args?: string[];
  /** Exact child environment; nothing is inherited. */
  env: NodeJS.ProcessEnv;
  clientInfo: { name: string; version: string };
  /** The server must answer initialize with exactly this version. */
  protocolVersion: string;
  startupTimeoutMs: number;
  maxPendingRequests: number;
  maxFrameBytes: number;
  errors: {
    /** Process, lifecycle, admission, deadline, and cancellation failures. */
    unavailable: (message: string, cause?: unknown) => Error;
    /** Malformed frames, JSON-RPC errors, and handshake contract violations. */
    protocol: (message: string, cause?: unknown) => Error;
  };
};

export type McpStdioClient = {
  isAvailable(): boolean;
  readonly cleanupResult?: ProcessCleanupResult;
  request(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
};

/**
 * A strict client for a caller-owned stdio MCP proxy process fronting a stateful driver.
 * Any connection anomaly retires the whole connection; the caller supplies the error taxonomy.
 */
export function createMcpStdioClient(params: McpStdioClientParams): McpStdioClient {
  const { errors, startupTimeoutMs } = params;
  let available = false;
  let stopped = false;
  let failure: Error | undefined;
  let shutdown: Promise<void> | undefined;
  let cleanupError: unknown;
  let inFlight = 0;
  const stderr = createCapturedOutputBuffers();

  class StdioProtocol extends Protocol<BaseContext> {
    protected buildContext(ctx: BaseContext): BaseContext {
      return ctx;
    }
    override async connect(transport: Transport, options?: RequestOptions): Promise<void> {
      const signal = options?.signal;
      const onAbort = () =>
        fail(errors.unavailable(`initialize timed out after ${startupTimeoutMs}ms`));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await super.connect(transport);
        const initialized = await request(
          "initialize",
          {
            protocolVersion: params.protocolVersion,
            capabilities: {},
            clientInfo: params.clientInfo,
          },
          { timeoutMs: startupTimeoutMs },
        );
        if (initialized.protocolVersion !== params.protocolVersion) {
          throw errors.protocol("proxy returned an incompatible protocol version");
        }
        await this.notification({ method: "notifications/initialized", params: {} });
        available = !stopped && !failure;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    protected assertCapabilityForMethod(): void {
      // This proxy client owns initialization and does not negotiate tool capabilities.
    }
    protected assertNotificationCapability(): void {
      // Initialization notifications and SDK protocol replies use this connection.
    }
    protected assertRequestHandlerCapability(method: string): void {
      if (method !== "ping") {
        throw new Error(`MCP stdio request handler is not supported: ${method}`);
      }
    }
  }

  class StdioTransport extends OpenClawStdioClientTransport {
    override onerror: OpenClawStdioClientTransport["onerror"] = (error) =>
      fail(
        error instanceof McpStdioFrameError
          ? errors.protocol(error.message, error.cause)
          : errors.unavailable("proxy failed to start", error),
      );
    override onexit: OpenClawStdioClientTransport["onexit"] = ({ code, signal }) => {
      if (!stopped && !failure) {
        const tail = finalizeCapturedOutput(stderr, "tail", true).toString("utf8").trim();
        fail(
          errors.unavailable(
            `proxy exited (${signal ?? code ?? "unknown"})${tail ? `: ${tail}` : ""}`,
          ),
        );
      }
    };

    override async send(message: JSONRPCMessage): Promise<void> {
      // SDK timeouts send cancellation before rejecting; fatal shutdown replaces it here.
      if ("method" in message && message.method === "notifications/cancelled") {
        return;
      }
      try {
        await super.send(message);
      } catch (error) {
        fail(errors.unavailable("proxy write failed", error));
        throw error;
      }
    }
  }

  const transport = new StdioTransport({
    command: params.command,
    args: params.args,
    env: params.env,
    exactEnv: true,
    decoder: new McpStdioFrameDecoder(params.maxFrameBytes),
  });
  // This strict proxy speaks legacy MCP; the low-level Protocol defaults to that era.
  const protocol = new StdioProtocol({ supportedProtocolVersions: [params.protocolVersion] });
  const onStderr = (chunk: Buffer) => {
    appendCapturedOutput(stderr, chunk, MAX_STDERR_BYTES, "tail");
  };
  transport.stderr.on("data", onStderr);
  const startupDeadline = monotonicNow() + startupTimeoutMs;
  const startup = import("./mcp-client-lifecycle.js")
    .then(({ connectMcpClient }) => {
      if (stopped || failure) {
        throw failure ?? errors.unavailable("proxy is stopping");
      }
      const remainingMs = startupDeadline - monotonicNow();
      if (remainingMs <= 0) {
        throw errors.unavailable(`initialize timed out after ${startupTimeoutMs}ms`);
      }
      return connectMcpClient({ client: protocol, transport, timeoutMs: remainingMs });
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error : errors.unavailable("proxy failed to start", error));
      throw failure ?? error;
    });
  void startup.catch(() => {});

  function beginShutdown(): void {
    shutdown ??= import("./mcp-client-lifecycle.js")
      .then(({ disposeMcpClient }) =>
        disposeMcpClient({
          client: protocol,
          transport,
          transportType: "stdio",
          detachStderr: () => transport.stderr.off("data", onStderr),
          onCleanupError: (error) => {
            materializeErrorStack(error);
            cleanupError = error;
          },
        }),
      )
      .then((outcome) => {
        if (outcome !== "closed") {
          throw errors.unavailable("proxy cleanup could not be confirmed", cleanupError);
        }
      });
    void shutdown.catch(materializeErrorStack);
  }

  function fail(error: Error): void {
    if (failure || stopped) {
      return;
    }
    materializeErrorStack(error);
    failure = error;
    // Retirement flushes SDK requests immediately while disposal retains process ownership.
    void transport.terminate().catch(() => undefined);
    beginShutdown();
  }

  async function request(
    method: string,
    requestParams: Record<string, unknown>,
    { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    if (failure) {
      throw failure;
    }
    if (stopped) {
      throw errors.unavailable("proxy is stopping");
    }
    if (signal?.aborted) {
      throw errors.unavailable("request was cancelled", signal.reason);
    }
    if (inFlight >= params.maxPendingRequests) {
      throw errors.unavailable("proxy has too many pending requests");
    }
    inFlight += 1;
    const onAbort = () => fail(errors.unavailable("request was cancelled", signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await protocol.request({ method, params: requestParams }, ResultSchema, {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
    } catch (error) {
      const { isMcpRequestTimeoutError } = await import("./mcp-error.js");
      if (isMcpRequestTimeoutError(error)) {
        fail(errors.unavailable(`${method} timed out after ${timeoutMs}ms`));
      }
      if (!failure && error instanceof ProtocolError) {
        // V2 leaves the numeric code out of message; strict-proxy callers retain that diagnostic.
        throw errors.protocol(`request failed: MCP error ${error.code}: ${error.message}`, error);
      }
      throw failure ?? error;
    } finally {
      inFlight -= 1;
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    isAvailable: () => available && !failure && !stopped,
    get cleanupResult() {
      return transport.cleanupResult;
    },
    async request(method, requestParams, options) {
      await startup;
      return request(method, requestParams, options);
    },
    async stop() {
      stopped = true;
      failure ??= errors.unavailable("proxy is stopping");
      materializeErrorStack(failure);
      void transport.retire().catch(() => undefined);
      beginShutdown();
      await startup.catch(() => undefined);
      await shutdown;
    },
  };
}
