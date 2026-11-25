import { createRequire } from "node:module";
import { setImmediate as waitForPostFetchCleanup } from "node:timers/promises";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
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

function expectTimeout(request: Promise<unknown>) {
  return Promise.all([
    expect(request).rejects.toBeInstanceOf(Error),
    expect(request).rejects.toHaveProperty(
      "name",
      expect.stringMatching(/^(AbortError|TimeoutError)$/),
    ),
  ]);
}

const clientDefaults = { botToken: "bot-token", allowPrivateNetwork: true };

async function withHangingServer(
  run: (server: {
    client: ReturnType<typeof createMattermostClient>;
    received: Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const received = Promise.withResolvers<void>();
  await withServer(
    (request) => {
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
  it.each([false, true])("rejects a hanging request (caller cancellation: %s)", async (cancel) => {
    await withHangingServer(async ({ client, received }) => {
      const controller = new AbortController();
      const request = cancel
        ? client.request("/users/me", { signal: controller.signal })
        : fetchMattermostMe(client);
      const outcome = expectTimeout(raceWithTimeout(request, 31_000, () => undefined));
      await Promise.race([received, request]);
      if (cancel) {
        controller.abort();
      }
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
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
        await expect(raceWithTimeout(request, 750, () => undefined)).rejects.toBe(reason);
      },
    );
  });

  it("preserves configured DM retry timeouts longer than the client default", async () => {
    await withHangingServer(async ({ client, received }) => {
      const request = createMattermostDirectChannelWithRetry(client, ["bot-user", "dm-user"], {
        maxRetries: 0,
        timeoutMs: 60_000,
      });
      const settled = vi.fn();
      const outcome = expectTimeout(
        raceWithTimeout(request.finally(settled), 60_002, () => undefined),
      );

      await Promise.race([received, request]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_001);
      await outcome;
    });
  });
});
