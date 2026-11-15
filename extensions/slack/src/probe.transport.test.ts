import type { RequestListener } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeFetch from "openclaw/plugin-sdk/runtime-fetch";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

type SlackProbeTransport = {
  result: ReturnType<typeof probeSlack>;
  deadline: AbortSignal;
  state: { settled: boolean; body?: Promise<string> };
  waitForRequest(): Promise<void>;
  waitForBody(): Promise<void>;
  waitForRetry(): Promise<boolean>;
};

async function withSlackProbeTransport(
  timeoutMs: number,
  handler: RequestListener,
  run: (transport: SlackProbeTransport) => Promise<void>,
): Promise<void> {
  const keys = ["SLACK_API_URL", "OPENCLAW_PROXY_ACTIVE", "OPENCLAW_PROXY_CA_FILE"];
  for (const prefix of ["HTTPS", "HTTP", "ALL", "NO"]) {
    keys.push(`${prefix}_PROXY`, `${prefix.toLowerCase()}_proxy`);
  }
  for (const key of keys) {
    vi.stubEnv(key, undefined);
  }
  const requestArrived = createDeferred<void>();
  const bodyStarted = createDeferred<void>();
  const socketClosed = createDeferred<void>();
  const retryArrived = createDeferred<void>();
  const deadlines: AbortController[] = [];
  const requestSignals: Array<AbortSignal | null | undefined> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let retryObservation: ReturnType<typeof setTimeout> | undefined;
  let requests = 0;
  const state: SlackProbeTransport["state"] = { settled: false };
  let result: ReturnType<typeof probeSlack> | undefined;
  const realFetch = runtimeFetch.fetchWithRuntimeDispatcher;
  try {
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        request.socket.once("close", () => socketClosed.resolve());
        requestArrived.resolve();
        if (requests === 2) {
          retryArrived.resolve();
        }
        handler(request, response);
      },
      async (baseUrl) => {
        vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
        });
        // Native deadlines ignore Vitest's clock; fake their scheduler, leaving SDK I/O real.
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
          const deadline = new AbortController();
          deadlines.push(deadline);
          setTimeout(() => deadline.abort(new DOMException("deadline", "TimeoutError")), delay);
          return deadline.signal;
        });
        vi.spyOn(runtimeFetch, "fetchWithRuntimeDispatcher").mockImplementation(
          async (input, init) => {
            requestSignals.push(init?.signal);
            const response = await realFetch(input, init);
            const readText = response.text.bind(response);
            vi.spyOn(response, "text").mockImplementation(() => {
              state.body = readText();
              void state.body.catch(() => undefined);
              bodyStarted.resolve();
              return state.body;
            });
            return response;
          },
        );

        const probe = probeSlack("probe-fixture", timeoutMs);
        result = probe;
        const markSettled = () => {
          state.settled = true;
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
          state,
          get deadline() {
            return deadlines[0]!.signal;
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
    await Promise.allSettled([result, state.body]);
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}

describe("probeSlack real network deadlines", () => {
  it.each(["stalled request", "trickling body"])(
    "aborts a %s at the absolute deadline",
    async (mode) => {
      const trickling = mode === "trickling body";
      let responseCompleted = false;
      await withSlackProbeTransport(
        100,
        (_request, response) => {
          if (!trickling) {
            return;
          }
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
          await (trickling ? transport.waitForBody() : transport.waitForRequest());
          await vi.advanceTimersByTimeAsync(99);
          expect(transport.state.settled).toBe(false);
          expect(transport.deadline.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(transport.deadline.aborted).toBe(true);
          if (trickling) {
            // SDK abort and shared timeout cleanup can race; either must end the real body.
            await expect(transport.state.body).rejects.toThrow();
            expect(responseCompleted).toBe(false);
          }
          await expect(transport.result).resolves.toMatchObject({ ok: false });
        },
      );
    },
  );

  it.each(["dropped request", "rate limit"])("does not retry a %s", async (mode) => {
    const rateLimited = mode === "rate limit";
    await withSlackProbeTransport(
      rateLimited ? 1_000 : 100,
      (_request, response) => {
        if (!rateLimited) {
          response.destroy();
          return;
        }
        response.writeHead(429, { "content-type": "application/json", "retry-after": "2" });
        response.end(`${JSON.stringify({ ok: false, error: "ratelimited" })}\n`);
      },
      async (transport) => {
        await transport.waitForRequest();
        // A rate limit must finish without advancing either Retry-After or the probe deadline.
        if (!rateLimited) {
          await vi.advanceTimersByTimeAsync(100);
        }
        await expect(transport.result).resolves.toMatchObject({
          ok: false,
          ...(rateLimited ? { error: expect.stringContaining("rate-limit") } : {}),
        });
        if (rateLimited) {
          expect(transport.deadline.aborted).toBe(false);
        } else {
          // Slack's default read retry is randomized between 500 and 1,000 ms.
          await vi.advanceTimersByTimeAsync(1_200);
          await expect(transport.waitForRetry()).resolves.toBe(false);
        }
      },
    );
  });
});
