import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "./runtime-api.js";

type QaGatewayRpcRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number;
};

export type QaGatewayRpcClient = {
  request(method: string, rpcParams?: unknown, opts?: QaGatewayRpcRequestOptions): Promise<unknown>;
  stop(): Promise<void>;
};

function formatQaGatewayRpcError(error: unknown, logs: () => string) {
  const details = formatErrorMessage(error);
  return new Error(`${details}\nGateway logs:\n${logs()}`);
}

let qaGatewayRpcQueue = Promise.resolve();

async function runQueuedQaGatewayRpc<T>(task: () => Promise<T>): Promise<T> {
  const run = qaGatewayRpcQueue.then(task, task);
  qaGatewayRpcQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
}

export async function startQaGatewayRpcClient(params: {
  wsUrl: string;
  token: string;
  logs: () => string;
}): Promise<QaGatewayRpcClient> {
  const wrapError = (error: unknown) => formatQaGatewayRpcError(error, params.logs);
  let stopped = false;

  return {
    async request(method, rpcParams, opts) {
      if (stopped) {
        throw wrapError(new Error("gateway rpc client already stopped"));
      }
      try {
        return await runQueuedQaGatewayRpc(
          async () =>
            await callGatewayFromCli(
              method,
              {
                url: params.wsUrl,
                token: params.token,
                timeout: String(opts?.timeoutMs ?? 20_000),
                expectFinal: opts?.expectFinal,
                json: true,
              },
              rpcParams ?? {},
              {
                expectFinal: opts?.expectFinal,
                progress: false,
              },
            ),
        );
      } catch (error) {
        throw wrapError(error);
      }
    },
    async stop() {
      stopped = true;
    },
  };
}
