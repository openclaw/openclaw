import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as responseLimitRuntime from "openclaw/plugin-sdk/response-limit-runtime";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeTelegram } from "./probe.js";

const INITIAL_BODY = '{"ok":true,"result":{"id":123';

describe("probeTelegram cancellation and body deadlines over real sockets", () => {
  let server: Server;
  let apiRoot: string;
  let mode: "backoff" | "all" | "webhook" | "stall" | "trickle" | "webhook-body";
  let pendingResponse: ServerResponse;
  let socketClosed = createDeferred<void>();
  let requestStarted = createDeferred<void>();
  let requestCount = 0;
  let connectionCount = 0;
  const liveSockets = new Set<Socket>();

  beforeAll(async () => {
    const proxyNames =
      "HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy OPENCLAW_PROXY_URL OPENCLAW_DEBUG_PROXY_ENABLED OPENCLAW_DEBUG_PROXY_URL";
    for (const name of proxyNames.split(" ")) {
      vi.stubEnv(name, "");
    }

    server = createServer((request, response) => {
      requestCount += 1;
      if (mode === "backoff") {
        response.socket?.destroy();
        return;
      }
      if (mode === "all" || (mode === "webhook" && request.url?.endsWith("/getWebhookInfo"))) {
        requestStarted.resolve();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if ((mode === "webhook" || mode === "webhook-body") && request.url?.endsWith("/getMe")) {
        response.end(
          '{"ok":true,"result":{"id":123,"is_bot":true,"first_name":"Test","username":"bot"}}',
        );
        return;
      }
      const closed = socketClosed;
      request.socket.once("close", () => closed.resolve());
      response.write(
        mode === "webhook-body"
          ? '{"ok":true,"result":{"url":"https://example.test/hook"'
          : INITIAL_BODY,
      );
      pendingResponse = response;
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      liveSockets.add(socket);
      socket.once("close", () => liveSockets.delete(socket));
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
  const beforeProbeEnds = <T>(milestone: Promise<T>, probe: Promise<unknown>) =>
    Promise.race([
      milestone,
      probe.then(() => {
        throw new Error("Probe completed before its socket/body milestone");
      }),
    ]);

  it.each(["backoff", "all", "webhook"] as const)("aborts during %s", async (phase) => {
    const controller = new AbortController();
    const requestsBefore = requestCount;
    const connectionsBefore = connectionCount;
    const backoffStarted = createDeferred<{ sleep: Promise<void> }>();
    requestStarted = createDeferred<void>();
    const realSleepWithAbort = runtimeEnv.sleepWithAbort;
    const sleepSpy =
      phase === "backoff"
        ? vi.spyOn(runtimeEnv, "sleepWithAbort").mockImplementation((...args) => {
            // Register the real abort listener before signaling readiness.
            const sleep = realSleepWithAbort(...args);
            backoffStarted.resolve({ sleep });
            return sleep;
          })
        : undefined;
    mode = phase;
    const startedAt = Date.now();
    const probe = probeTelegram(`abort-${phase}-token`, 10_000, {
      apiRoot,
      includeWebhookInfo: phase === "webhook",
      abortSignal: controller.signal,
      network: { autoSelectFamily: false, dnsResultOrder: "verbatim" },
    });
    try {
      if (phase === "backoff") {
        const { sleep } = await beforeProbeEnds(backoffStarted.promise, probe);
        controller.abort();
        await expect(sleep).rejects.toMatchObject({
          name: "AbortError",
          cause: controller.signal.reason,
        });
      } else {
        await requestStarted.promise;
        controller.abort();
      }
      expect((await probe).ok).toBe(false);
      expect(requestCount).toBe(requestsBefore + (phase === "webhook" ? 2 : 1));
      if (phase !== "webhook") {
        expect(connectionCount).toBe(connectionsBefore + 1);
      }
      if (phase !== "backoff") {
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      }
    } finally {
      controller.abort();
      sleepSpy?.mockRestore();
      await probe;
    }
  });

  it.each([
    ["stall", expect.stringMatching(/response body stalled/i), 100],
    ["trickle", expect.stringMatching(/response body timed out/i), 200],
  ] as const)("times out %s bodies", async (bodyMode, error, elapsedMs) => {
    // Connection setup and socket scheduling must not consume the probe's budget.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    mode = bodyMode;
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
    const probe = probeTelegram(`deadline-${bodyMode}-${++probeIndex}`, 200, {
      apiRoot,
      includeWebhookInfo: false,
      abortSignal: abort.signal,
    });
    try {
      await beforeProbeEnds(waitForConsumedBytes(INITIAL_BODY.length), probe);
      for (let index = 1; index <= (bodyMode === "trickle" ? 4 : 0); index += 1) {
        await vi.advanceTimersByTimeAsync(40);
        const consumed = waitForConsumedBytes(INITIAL_BODY.length + index);
        pendingResponse.write(" ");
        await beforeProbeEnds(consumed, probe);
      }
      await vi.advanceTimersByTimeAsync(bodyMode === "trickle" ? 40 : 100);
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
    mode = "webhook-body";
    socketClosed = createDeferred<void>();
    const previousRequestCount = requestCount;

    const result = await probeTelegram(`deadline-webhook-${++probeIndex}`, 200, { apiRoot });

    expect(result).toMatchObject({ ok: true, bot: { id: 123, username: "bot" } });
    expect(result.webhook).toBeUndefined();
    expect(requestCount).toBe(previousRequestCount + 2);
    await socketClosed.promise;
  });
});
