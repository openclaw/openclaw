// Prove Slack probe deadlines against the real SDK and loopback HTTP transport.
import type { RequestListener } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeFetch from "openclaw/plugin-sdk/runtime-fetch";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;

const originalEnv = Object.fromEntries(
  TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof TEST_ENV_KEYS)[number], string | undefined>;

function clearSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

type SlackProbeTransport = {
  result: ReturnType<typeof probeSlack>;
  deadline: AbortSignal;
  readonly settled: boolean;
  readonly body: Promise<string> | undefined;
  waitForRequest(): Promise<void>;
  waitForBody(): Promise<void>;
  waitForRetry(): Promise<boolean>;
};

async function withSlackProbeTransport(
  timeoutMs: number,
  handler: RequestListener,
  run: (transport: SlackProbeTransport) => Promise<void>,
): Promise<void> {
  clearSlackTransportEnv();
  const requestArrived = createDeferred<void>();
  const bodyStarted = createDeferred<void>();
  const socketClosed = createDeferred<void>();
  const retryArrived = createDeferred<void>();
  const deadlines: AbortController[] = [];
  const restoreMocks: Array<() => void> = [];
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let retryObservation: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;
  let settled = false;
  let body: Promise<string> | undefined;
  let result: ReturnType<typeof probeSlack> | undefined;
  const realFetch = runtimeFetch.fetchWithRuntimeDispatcher;
  try {
    await withServer(
      (request, response) => {
        requests += 1;
        request.socket.once("close", () => socketClosed.resolve());
        requestArrived.resolve();
        if (requests === 2) {
          retryArrived.resolve();
        }
        handler(request, response);
      },
      async (baseUrl) => {
        process.env.SLACK_API_URL = `${baseUrl}/api/`;
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        // Native AbortSignal.timeout does not follow Vitest's clock. Control only
        // its scheduler; SDK requests, response bodies, and sockets remain real.
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
          const deadline = new AbortController();
          deadlines.push(deadline);
          setTimeout(
            () => deadline.abort(new DOMException("Probe deadline", "TimeoutError")),
            delay,
          );
          return deadline.signal;
        });
        restoreMocks.push(() => timeout.mockRestore());
        const fetchSpy = vi
          .spyOn(runtimeFetch, "fetchWithRuntimeDispatcher")
          .mockImplementation(async (input, init) => {
            requestSignals.push(init?.signal);
            const response = await realFetch(input, init);
            const readText = response.text.bind(response);
            const textSpy = vi.spyOn(response, "text").mockImplementation(() => {
              body = readText();
              void body.catch(() => undefined);
              bodyStarted.resolve();
              return body;
            });
            restoreMocks.push(() => textSpy.mockRestore());
            return response;
          });
        restoreMocks.push(() => fetchSpy.mockRestore());

        const probe = probeSlack("probe-fixture", timeoutMs);
        result = probe;
        const markSettled = () => {
          settled = true;
        };
        void probe.then(markSettled, markSettled);
        const waitFor = (phase: Promise<void>, name: string) =>
          Promise.race([
            phase,
            probe.then(() => {
              throw new Error(`Slack probe ended before ${name}`);
            }),
          ]);
        await run({
          result: probe,
          get deadline() {
            return deadlines[0]!.signal;
          },
          get settled() {
            return settled;
          },
          get body() {
            return body;
          },
          waitForRequest: () => waitFor(requestArrived.promise, "request admission"),
          waitForBody: () => waitFor(bodyStarted.promise, "response-body admission"),
          // Retain the native I/O observation window after advancing Slack's retry clock.
          waitForRetry: () =>
            Promise.race([
              retryArrived.promise.then(() => true),
              new Promise<boolean>((resolve) => {
                retryObservation = nativeSetTimeout(() => resolve(false), 100);
              }),
            ]),
        });
        expect(timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs);
        expect(requestSignals).toEqual([deadlines[0]?.signal]);
        await socketClosed.promise;
        expect(requests).toBe(1);
      },
    );
  } finally {
    nativeClearTimeout(retryObservation);
    for (const deadline of deadlines) {
      deadline.abort();
    }
    try {
      await Promise.allSettled([result, body]);
    } finally {
      for (const restore of restoreMocks.toReversed()) {
        restore();
      }
      vi.useRealTimers();
    }
  }
}

afterEach(() => {
  restoreSlackTransportEnv();
});

describe("probeSlack real network deadlines", () => {
  it("aborts a stalled Slack request and closes its only socket", async () => {
    await withSlackProbeTransport(
      100,
      (request) => request.resume(),
      async (transport) => {
        await transport.waitForRequest();
        await vi.advanceTimersByTimeAsync(99);
        expect(transport.settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport.deadline.aborted).toBe(true);
        await expect(transport.result).resolves.toMatchObject({ ok: false });
      },
    );
  });

  it("does not retry a dropped request after the probe has already returned", async () => {
    await withSlackProbeTransport(
      100,
      (request, response) => {
        request.resume();
        response.destroy();
      },
      async (transport) => {
        await transport.waitForRequest();
        await vi.advanceTimersByTimeAsync(100);
        await expect(transport.result).resolves.toMatchObject({ ok: false });

        // The default Slack read retry is randomized between 500 and 1,000 ms.
        await vi.advanceTimersByTimeAsync(1_200);
        await expect(transport.waitForRetry()).resolves.toBe(false);
      },
    );
  });

  it("rejects a rate limit without waiting or retrying", async () => {
    await withSlackProbeTransport(
      1_000,
      (request, response) => {
        request.resume();
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "2",
        });
        response.end(`${JSON.stringify({ ok: false, error: "ratelimited" })}\n`);
      },
      async (transport) => {
        await transport.waitForRequest();
        // No clock advancement: a Retry-After sleep or probe timeout cannot satisfy this.
        await expect(transport.result).resolves.toMatchObject({
          ok: false,
          error: expect.stringContaining("rate-limit"),
        });
        expect(transport.deadline.aborted).toBe(false);
      },
    );
  });

  it("aborts response-body trickling at the absolute probe deadline", async () => {
    let responseCompleted = false;
    await withSlackProbeTransport(
      100,
      (request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.write(" ");
        const trickle = setInterval(() => response.write(" "), 25);
        const finish = setTimeout(() => {
          responseCompleted = true;
          clearInterval(trickle);
          response.end(`${JSON.stringify({ ok: true })}\n`);
        }, 750);
        response.once("close", () => {
          clearInterval(trickle);
          clearTimeout(finish);
        });
      },
      async (transport) => {
        await transport.waitForBody();
        await vi.advanceTimersByTimeAsync(99);
        expect(transport.settled).toBe(false);
        expect(transport.deadline.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(transport.deadline.aborted).toBe(true);
        // SDK abort and shared timeout cleanup can race; either must end the real body.
        await expect(transport.body).rejects.toThrow();
        await expect(transport.result).resolves.toMatchObject({ ok: false });
        expect(responseCompleted).toBe(false);
      },
    );
  });
});
