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
      // Advance deadlines only after real socket I/O.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const client = createMattermostClient({ ...clientDefaults, baseUrl });
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
    ["default client deadline", false],
    ["caller AbortSignal with a default deadline", true],
  ] as const)("rejects a hanging request through %s", async (_name, cancel) => {
    await withHangingServer(async ({ client, received, requestCount }) => {
      const controller = new AbortController();
      const request = cancel
        ? client.request("/users/me", { signal: controller.signal })
        : fetchMattermostMe(client);
      const outcome = settleWithin(request, 31_000);
      await Promise.race([received, request]);
      if (cancel) {
        controller.abort();
      } else {
        expect(requestCount()).toBe(1);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expectTimeoutOutcome(await outcome);
    });
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
        const client = createMattermostClient({ ...clientDefaults, baseUrl });
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
        timeoutMs: 60_000,
      });
      const earlyOutcome = settleWithin(request, 30_001);

      await Promise.race([received, request]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await earlyOutcome).toEqual({ status: "pending" });
      const outcome = settleWithin(request, 30_001);
      await vi.advanceTimersByTimeAsync(30_001);
      expectTimeoutOutcome(await outcome);
    });
  });
});
