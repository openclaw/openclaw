import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as responseLimitRuntime from "openclaw/plugin-sdk/response-limit-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram } from "./probe.js";

const INITIAL_BODY = '{"ok":true,"result":{"id":123';

describe("probeTelegram response body deadlines over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  let webhook = false;
  let pendingResponse: ServerResponse;
  let socketClosed = createDeferred<void>();
  const webhookClosed = createDeferred<void>();
  let requestCount = 0;

  beforeAll(async () => {
    const proxyNames =
      "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy OPENCLAW_PROXY_URL OPENCLAW_DEBUG_PROXY_ENABLED OPENCLAW_DEBUG_PROXY_URL";
    for (const name of proxyNames.split(" ")) {
      vi.stubEnv(name, "");
    }

    server = createServer((request, response) => {
      requestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      if (webhook && request.url?.endsWith("/getMe")) {
        response.end(
          '{"ok":true,"result":{"id":123,"is_bot":true,"first_name":"Test","username":"bot"}}',
        );
        return;
      }
      const closed = webhook ? webhookClosed : socketClosed;
      request.socket.once("close", () => closed.resolve());
      response.write(
        webhook ? '{"ok":true,"result":{"url":"https://example.test/hook"' : INITIAL_BODY,
      );
      pendingResponse = response;
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  let probeIndex = 0;

  it.each([
    ["stall", expect.stringMatching(/response body stalled/i), 100],
    ["trickle", expect.stringMatching(/response body timed out/i), 200],
  ] as const)("times out %s bodies", async (mode, error, elapsedMs) => {
    // Connection setup and socket scheduling must not consume the probe's budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    socketClosed = createDeferred<void>();
    const previousRequestCount = requestCount;
    let receivedBytes = 0;
    let consumedBytes = 0;
    let readProgress = createDeferred<void>();
    const waitForConsumedBytes = async (minimum: number) => {
      for (let consumed = consumedBytes; consumed < minimum; consumed = consumedBytes) {
        await readProgress.promise;
      }
    };
    const readResponseWithLimit = responseLimitRuntime.readResponseWithLimit;
    vi.spyOn(responseLimitRuntime, "readResponseWithLimit").mockImplementation(
      (response, maxBytes, options) => {
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
            // A new read means prior bytes were consumed and the idle deadline refreshed.
            consumedBytes = receivedBytes;
            readProgress.resolve();
            readProgress = createDeferred<void>();
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
      await beforeProbeEnds(waitForConsumedBytes(INITIAL_BODY.length));
      for (let index = 1; index <= (mode === "trickle" ? 4 : 0); index += 1) {
        await vi.advanceTimersByTimeAsync(40);
        const consumed = waitForConsumedBytes(INITIAL_BODY.length + index);
        pendingResponse.write(" ");
        await beforeProbeEnds(consumed);
      }
      await vi.advanceTimersByTimeAsync(mode === "trickle" ? 40 : 100);
      const result = await probe;
      expect(result).toMatchObject({ ok: false, error, elapsedMs });
      expect(requestCount).toBe(previousRequestCount + 1);
      await socketClosed.promise;
    } finally {
      abort.abort();
      await probe;
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("keeps webhook diagnostics best-effort and closes their stalled socket", async () => {
    webhook = true;
    const previousRequestCount = requestCount;

    const result = await probeTelegram(`deadline-webhook-${++probeIndex}`, 200, { apiRoot });

    expect(result).toMatchObject({ ok: true, bot: { id: 123, username: "bot" } });
    expect(result.webhook).toBeUndefined();
    expect(requestCount).toBe(previousRequestCount + 2);
    await webhookClosed.promise;
  });
});
