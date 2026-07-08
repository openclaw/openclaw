import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 50;
const PENDING_PROOF_MS = 350;
const REQUEST_RECEIVED_TIMEOUT_MS = 1_000;
const CLOSE_SETTLE_MS = 1_000;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type LoopbackHangingServer = {
  baseUrl: string;
  receivedRequest: Promise<void>;
  receivedRequests: string[];
  close: () => Promise<void>;
};

type OperationOutcome =
  | { status: "pending" }
  | { status: "resolved" }
  | { status: "rejected"; name: string; message: string };

function createDeferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeLoopbackServer(server: Server, sockets: Set<Socket>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as { code?: string }).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

async function createLoopbackHangingServer(): Promise<LoopbackHangingServer> {
  const receivedRequest = createDeferred();
  const receivedRequests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req: IncomingMessage) => {
    receivedRequests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`);
    receivedRequest.resolve();
    req.resume();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  const port = await listenLoopbackServer(server);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    receivedRequest: receivedRequest.promise,
    receivedRequests,
    close: async () => closeLoopbackServer(server, sockets),
  };
}

function createTalkConfig(baseUrl: string): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl,
        botSecret: "test-secret",
        network: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
    },
  };
}

function toOperationOutcome(operation: Promise<unknown>): Promise<OperationOutcome> {
  return operation.then(
    () => ({ status: "resolved" }) satisfies OperationOutcome,
    (error: unknown) => ({
      status: "rejected",
      name: error instanceof Error ? error.name : "",
      message: error instanceof Error ? error.message : String(error),
    }) satisfies OperationOutcome,
  );
}

async function expectRequestReceived(server: LoopbackHangingServer, pathPart: string) {
  const received = await Promise.race([
    server.receivedRequest.then(() => "received" as const),
    delay(REQUEST_RECEIVED_TIMEOUT_MS, "missing" as const),
  ]);

  expect(received).toBe("received");
  expect(server.receivedRequests.some((request) => request.includes(pathPart))).toBe(true);
}

async function expectHangingTalkRequestTimesOut(params: {
  pathPart: string;
  run: (baseUrl: string) => Promise<unknown>;
}) {
  const server = await createLoopbackHangingServer();
  const operation = toOperationOutcome(params.run(server.baseUrl));

  try {
    await expectRequestReceived(server, params.pathPart);

    const outcome = await Promise.race([
      operation,
      delay(PENDING_PROOF_MS, { status: "pending" } satisfies OperationOutcome),
    ]);

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    expect(["AbortError", "TimeoutError"]).toContain(outcome.name);
  } finally {
    await server.close();
    await Promise.race([
      operation,
      delay(CLOSE_SETTLE_MS, { status: "pending" } satisfies OperationOutcome),
    ]);
  }
}

describe("nextcloud-talk send fetch timeouts", () => {
  it("rejects a hanging message send after the request timeout", async () => {
    await expectHangingTalkRequestTimesOut({
      pathPart: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
      run: async (baseUrl) =>
        sendMessageNextcloudTalk("room:abc123", "hello", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
  });

  it("rejects a hanging reaction send after the request timeout", async () => {
    await expectHangingTalkRequestTimesOut({
      pathPart: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1",
      run: async (baseUrl) =>
        sendReactionNextcloudTalk("room:abc123", "m-1", "ok", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
  });
});
