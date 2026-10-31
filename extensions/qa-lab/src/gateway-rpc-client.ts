import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { formatQaGatewayLogsForError } from "./gateway-log-redaction.js";

type QaGatewayClientOptions = ConstructorParameters<typeof GatewayClient>[0];
type QaGatewayHello = Parameters<NonNullable<QaGatewayClientOptions["onHelloOk"]>>[0];
type QaGatewayReconnectPausedInfo = Parameters<
  NonNullable<QaGatewayClientOptions["onReconnectPaused"]>
>[0];

type QaGatewayRpcRequestOptions = {
  deadlineMs?: number;
  expectFinal?: boolean;
  timeoutMs?: number;
};

type QaGatewayRpcClient = {
  readonly evidenceIdentity: { protocol: number; version: string } | null;
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

type QaGatewayConnectionGate = ReturnType<typeof createQaGatewayConnectionGate>;

const QA_GATEWAY_RPC_TIMEOUT_MS = 20_000;

function createQaGatewayConnectionGate() {
  const { promise, resolve, reject } = createDeferred<void>();
  // A terminal reconnect error can arrive without an active request waiter.
  void promise.catch(() => {});
  return { connected: false, promise, reject, resolve };
}

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const cause = toErrorObject(error, "Gateway RPC request failed");
  const details = formatErrorMessage(cause);
  return new Error(`${details}${formatQaGatewayLogsForError(logs())}`, { cause });
}

function qaGatewayDeadlineError() {
  return new Error("gateway request deadline exceeded");
}

async function waitForQaGatewayConnection(
  gate: QaGatewayConnectionGate,
  expiresAt: number,
): Promise<void> {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    throw qaGatewayDeadlineError();
  }
  await raceWithTimeout(gate.promise, remainingMs, () => {
    throw qaGatewayDeadlineError();
  });
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  logs: () => string;
  deviceIdentity?: QaGatewayClientOptions["deviceIdentity"];
  scopes?: QaGatewayClientOptions["scopes"];
}): Promise<QaGatewayRpcClient> {
  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);
  let stopped = false;
  let connection = createQaGatewayConnectionGate();
  let evidenceIdentity: QaGatewayRpcClient["evidenceIdentity"] = null;
  const assertNotStopped = () => {
    if (stopped) {
      throw new Error("gateway rpc client already stopped");
    }
  };

  const client = new GatewayClient({
    url: params.wsUrl,
    token: params.token,
    requestTimeoutMs: QA_GATEWAY_RPC_TIMEOUT_MS,
    clientName: "gateway-client",
    deviceIdentity: params.deviceIdentity ?? null,
    // Ephemeral observers must not persist hello tokens into shared client state.
    ...(params.deviceIdentity ? { sharedStateMode: "read-only" as const } : {}),
    mode: "backend",
    scopes: params.scopes ?? ["operator.admin"],
    onHelloOk: (hello: QaGatewayHello) => {
      // Retain only target-observed protocol/version, never hello auth or tokens.
      evidenceIdentity = { protocol: hello.protocol, version: hello.server.version };
      connection.connected = true;
      connection.resolve();
    },
    onClose: () => {
      evidenceIdentity = null;
      if (!stopped && connection.connected) {
        connection = createQaGatewayConnectionGate();
      }
    },
    onReconnectPaused: (info: QaGatewayReconnectPausedInfo) => {
      evidenceIdentity = null;
      const error = new Error(
        `gateway reconnect paused (${info.code}): ${info.reason}${info.detailCode ? ` [${info.detailCode}]` : ""}`,
      );
      if (connection.connected) {
        connection = createQaGatewayConnectionGate();
      }
      connection.reject(error);
    },
  });

  try {
    const startupExpiresAt = Date.now() + QA_GATEWAY_RPC_TIMEOUT_MS;
    const readiness = await startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: QA_GATEWAY_RPC_TIMEOUT_MS,
    });
    if (!readiness.ready) {
      throw new Error("gateway event loop readiness timeout");
    }
    await waitForQaGatewayConnection(connection, startupExpiresAt);
  } catch (error) {
    stopped = true;
    await client.stopAndWait().catch(() => {});
    throw wrapError(error);
  }

  return {
    get evidenceIdentity() {
      return evidenceIdentity ? { ...evidenceIdentity } : null;
    },
    async request(method, rpcParams, opts) {
      try {
        assertNotStopped();
        const startedAt = Date.now();
        const expiresAt = Math.min(
          startedAt + (opts?.timeoutMs ?? QA_GATEWAY_RPC_TIMEOUT_MS),
          opts?.deadlineMs ?? Infinity,
        );
        await waitForQaGatewayConnection(connection, expiresAt);
        assertNotStopped();
        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          throw qaGatewayDeadlineError();
        }
        // A disconnect during dispatch fails this request; never replay a possible mutation.
        return await client.request(method, rpcParams ?? {}, {
          expectFinal: opts?.expectFinal,
          timeoutMs: remainingMs,
        });
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
      evidenceIdentity = null;
      connection.reject(new Error("gateway rpc client stopped"));
      await client.stopAndWait();
    },
  };
}
