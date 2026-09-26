// Real-socket proof for diagnostic response deadlines: production Telegram
// transport and body reader against a manually paced local HTTP server.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as responseLimitRuntime from "openclaw/plugin-sdk/response-limit-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram } from "./probe.js";

type ResponseMode = "stall" | "trickle" | "webhook-stall";
const INITIAL_BODY = '{"ok":true,"result":{"id":123';

describe("probeTelegram response body deadlines over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  let responseMode: ResponseMode = "stall";
  let responseStarted = createDeferred<ServerResponse>();
  let socketClosed = createDeferred<void>();
  let requestCount = 0;
  let closedSocketCount = 0;
  let stalledWebhookSocket: Socket | undefined;
  const liveSockets = new Set<Socket>();

  beforeAll(async () => {
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_PROXY_URL",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
    ]) {
      vi.stubEnv(name, "");
    }

    server = createServer((request, response) => {
      requestCount += 1;
      const closed = socketClosed;
      request.socket.once("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      if (responseMode === "webhook-stall") {
        if (request.url?.endsWith("/getMe")) {
          response.end(
            JSON.stringify({
              ok: true,
              result: { id: 123, is_bot: true, first_name: "Test", username: "bot" },
            }),
          );
        } else {
          stalledWebhookSocket = request.socket;
          response.write('{"ok":true,"result":{"url":"https://example.test/hook"');
        }
        return;
      }
      response.write(INITIAL_BODY);
      responseStarted.resolve(response);
    });
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.once("close", () => {
        liveSockets.delete(socket);
        closedSocketCount += 1;
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const socket of liveSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  let probeIndex = 0;

  async function expectDeadlineFailure(mode: ResponseMode, expectedError: RegExp) {
    responseMode = mode;
    // Connection setup and socket scheduling must not consume the probe's budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    responseStarted = createDeferred<ServerResponse>();
    socketClosed = createDeferred<void>();
    const headersReceived = createDeferred<void>();
    const previousRequestCount = requestCount;
    const previousClosedSocketCount = closedSocketCount;
    let receivedBytes = 0;
    let consumedBytes = 0;
    let onRead: (() => void) | undefined;
    const waitForConsumedBytes = (minimum: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (consumedBytes >= minimum) {
            onRead = undefined;
            resolve();
          }
        };
        onRead = check;
        check();
      });
    const readResponseWithLimit = responseLimitRuntime.readResponseWithLimit;
    vi.spyOn(responseLimitRuntime, "readResponseWithLimit").mockImplementation(
      (response, maxBytes, options) => {
        headersReceived.resolve();
        const body = response.body;
        if (!body) {
          throw new Error("Expected the real socket response body");
        }
        const getReader = body.getReader.bind(body);
        vi.spyOn(body, "getReader").mockImplementation((readerOptions) => {
          if (readerOptions !== undefined) {
            return getReader(readerOptions);
          }
          const reader = getReader();
          const read = reader.read.bind(reader);
          vi.spyOn(reader, "read").mockImplementation(async () => {
            // The next read starts after the previous bytes were consumed and
            // the real idle deadline was refreshed. Forward all stream results.
            consumedBytes = receivedBytes;
            onRead?.();
            const result = await read();
            if (!result.done) {
              receivedBytes += result.value.byteLength;
            }
            return result;
          });
          return reader;
        });
        return readResponseWithLimit(response, maxBytes, options);
      },
    );
    const abort = new AbortController();
    const probe = probeTelegram(`deadline-${mode}-${++probeIndex}`, 200, {
      apiRoot,
      includeWebhookInfo: false,
      abortSignal: abort.signal,
    });
    const beforeProbeEnds = async (milestone: Promise<unknown>) =>
      await Promise.race([
        milestone,
        probe.then((result) => {
          throw new Error(`Probe ended before the socket body milestone: ${result.error}`);
        }),
      ]);

    try {
      await beforeProbeEnds(headersReceived.promise);
      await beforeProbeEnds(waitForConsumedBytes(INITIAL_BODY.length));
      const response = await responseStarted.promise;
      if (mode === "trickle") {
        for (let index = 1; index <= 4; index += 1) {
          await vi.advanceTimersByTimeAsync(40);
          const consumed = waitForConsumedBytes(INITIAL_BODY.length + index);
          response.write(" ");
          await beforeProbeEnds(consumed);
        }
        await vi.advanceTimersByTimeAsync(40);
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      const result = await probe;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(expectedError);
      expect(result.elapsedMs).toBe(mode === "stall" ? 100 : 200);
      expect(requestCount).toBe(previousRequestCount + 1);
      await socketClosed.promise;
      expect(closedSocketCount).toBeGreaterThan(previousClosedSocketCount);
    } finally {
      abort.abort();
      await probe;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  }

  it("cancels a socket whose response body stalls", async () => {
    await expectDeadlineFailure("stall", /response body stalled/i);
  });

  it("enforces the overall deadline while body bytes keep arriving", async () => {
    await expectDeadlineFailure("trickle", /response body timed out/i);
  });

  it("keeps webhook diagnostics best-effort and closes their stalled socket", async () => {
    responseMode = "webhook-stall";
    stalledWebhookSocket = undefined;
    const previousRequestCount = requestCount;

    const result = await probeTelegram(`deadline-webhook-${++probeIndex}`, 200, { apiRoot });

    expect(result.ok).toBe(true);
    expect(result.bot).toMatchObject({ id: 123, username: "bot" });
    expect(result.webhook).toBeUndefined();
    expect(requestCount).toBe(previousRequestCount + 2);
    await vi.waitFor(() => expect(stalledWebhookSocket?.destroyed).toBe(true), {
      timeout: 1_000,
    });
  });
});
