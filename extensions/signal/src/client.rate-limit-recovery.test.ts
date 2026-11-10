import { once } from "node:events";
import { chmod, realpath } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { signalRpcRequest } from "./client.js";

// Verbatim shape from signal-cli's SignalJsonRpcCommandHandler#getErrorDataNode: a
// rate-limit exception is mapped to JSON-RPC -5 and the captured send response is
// wrapped in error.data.response, not put in error.message (#195280).
const RATE_LIMITED_RESULTS = [
  { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 61 },
  { type: "RATE_LIMIT_FAILURE", retryAfterSeconds: 120, token: "challenge-token-abc" },
];
const errorEnvelope = (id: unknown) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -5,
      message: "Failed to send message due to rate limiting",
      data: { response: { timestamp: 1762000000000, results: RATE_LIMITED_RESULTS } },
    },
  });

const EXPECTED_GUIDANCE =
  "rate limited: retry after 120s; captcha proof required; " +
  "run `signal-cli submitRateLimitChallenge` before sending again";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function unixServer(handler: (payload: Record<string, unknown>, socket: net.Socket) => void) {
  const dir = tempDirs.make("signal-rate-limit-", await realpath(os.tmpdir()));
  await chmod(dir, 0o700);
  const socketPath = path.join(dir, "rpc.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline !== -1) {
        handler(JSON.parse(input.slice(0, newline)) as Record<string, unknown>, socket);
        input = input.slice(newline + 1);
      }
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  return {
    baseUrl: pathToFileURL(socketPath).href.replace(/^file:/, "unix:"),
    dir,
  };
}

async function httpServer(handler: (id: unknown) => string) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const payload = JSON.parse(body) as { id?: unknown };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(handler(payload.id));
    });
  });
  const port = await listenOnLoopback(server);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}`;
}

describe("Signal rate-limit recovery details (#195280)", () => {
  it("surfaces retry time and captcha guidance over HTTP JSON-RPC", async () => {
    const baseUrl = await httpServer(errorEnvelope);
    const error = await signalRpcRequest("send", { message: "hi" }, { baseUrl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Signal RPC -5: Failed to send message due to rate limiting");
    expect(message).toContain(EXPECTED_GUIDANCE);
    // The captcha token is what the operator needs to solve, but diagnostic text
    // must not carry it; only the recovery command is named.
    expect(message).not.toContain("challenge-token-abc");
  });

  it("surfaces the same guidance over the UNIX socket transport", async () => {
    const { baseUrl } = await unixServer((payload, socket) => {
      socket.end(`${errorEnvelope(payload.id)}\n`);
    });
    const error = await signalRpcRequest("send", { message: "hi" }, { baseUrl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // The socket transport still redacts remote text, but must keep the safe facts.
    expect(message).toBe(`Signal RPC -5: remote error (${EXPECTED_GUIDANCE})`);
  });

  it("keeps the generic redacted error when the envelope carries no rate limit", async () => {
    const { baseUrl } = await unixServer((payload, socket) => {
      socket.end(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          error: { code: -5, message: "Failed to send for +155****0001" },
        })}\n`,
      );
    });
    await expect(signalRpcRequest("send", undefined, { baseUrl })).rejects.toThrow(
      "Signal RPC -5: remote error",
    );
  });
});
