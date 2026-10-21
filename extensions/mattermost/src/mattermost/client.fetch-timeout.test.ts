import { createRequire } from "node:module";
import { setImmediate as waitForPostFetchCleanup } from "node:timers/promises";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostMe,
} from "./client.js";

// Undici's testing-only reset releases timers that retain Vitest's retired clock.
const undiciTimers: { reset: () => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);

async function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function expectTimeoutOutcome(outcome: Awaited<ReturnType<typeof settleWithin>>): void {
  expect(outcome).toEqual({ status: "rejected", error: expect.any(Error) });
  expect(outcome).toHaveProperty(
    "error.name",
    expect.stringMatching(/^(AbortError|TimeoutError)$/),
  );
}

const clientDefaults = { botToken: "bot-token", allowPrivateNetwork: true };

async function withHangingServer(
  run: (server: {
    client: ReturnType<typeof createMattermostClient>;
    received: Promise<void>;
    requestCount: () => number;
  }) => Promise<void>,
  timeoutMs = 50,
): Promise<void> {
  let requestCount = 0;
  const received = Promise.withResolvers<void>();
  await withServer(
    (request) => {
      requestCount += 1;
      received.resolve();
      request.resume();
    },
    async (baseUrl) => {
      // Advance deadlines after real socket I/O; loaded workers may connect after 50ms.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const client = createMattermostClient({ ...clientDefaults, baseUrl, timeoutMs });
        await run({
          client,
          received: received.promise,
          requestCount: () => requestCount,
        });
      } finally {
        undiciTimers.reset();
        vi.useRealTimers();
      }
    },
  );
}

describe("Mattermost REST client fetch timeout", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["configured client deadline", 50, false],
    ["caller AbortSignal with a default deadline", 30_000, true],
  ] as const)("rejects a hanging request through %s", async (_name, timeoutMs, cancel) => {
    await withHangingServer(async ({ client, received, requestCount }) => {
      const controller = new AbortController();
      const request = cancel
        ? client.request("/users/me", { signal: controller.signal })
        : fetchMattermostMe(client);
      const outcome = settleWithin(request, 750);
      await Promise.race([received, request]);
      if (cancel) {
        controller.abort();
      } else {
        expect(requestCount()).toBe(1);
      }
      await vi.advanceTimersByTimeAsync(750);
      expectTimeoutOutcome(await outcome);
    }, timeoutMs);
  });

  it("preserves caller cancellation through a guarded response body", async () => {
    const fetchResolved = Promise.withResolvers<void>();
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"id":"partial');
      },
      async (baseUrl) => {
        const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
        vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async (params) => {
          const result = await guardedFetch(params);
          fetchResolved.resolve();
          return result;
        });
        const client = createMattermostClient({ ...clientDefaults, baseUrl, timeoutMs: 30_000 });
        const controller = new AbortController();
        const reason = new Error("caller stopped after headers");
        const request = client.request("/users/me", { signal: controller.signal });

        await fetchResolved.promise;
        await waitForPostFetchCleanup();
        controller.abort(reason);
        expect(await settleWithin(request, 750)).toEqual({ status: "rejected", error: reason });
      },
    );
  });

  it("preserves configured DM retry timeouts longer than the client default", async () => {
    await withHangingServer(async ({ client, received }) => {
      const request = createMattermostDirectChannelWithRetry(client, ["bot-user", "dm-user"], {
        maxRetries: 0,
        timeoutMs: 250,
      });
      const earlyOutcome = settleWithin(request, 120);

      await Promise.race([received, request]);
      await vi.advanceTimersByTimeAsync(120);
      expect(await earlyOutcome).toEqual({ status: "pending" });
      const outcome = settleWithin(request, 600);
      await vi.advanceTimersByTimeAsync(600);
      expectTimeoutOutcome(await outcome);
    });
  });
});
