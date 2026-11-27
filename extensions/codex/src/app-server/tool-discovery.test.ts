import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { createModelFixture } from "./model-fixture.test-support.js";
import {
  acquireCodexToolDiscoveryClient,
  isCodexModelListedOnConnection,
} from "./tool-discovery.js";

afterEach(() => vi.useRealTimers());

function createDiscoveryClient() {
  const fixture = createFakeCodexAppServerClient(async () => ({}));
  fixture.client.close = vi.fn(fixture.close);
  return fixture;
}

const signal = new AbortController().signal;

it.each([true, false])(
  "releases a custom startup client according to caller ownership (%s)",
  async (callerOwnedAttemptClient) => {
    const { client } = createDiscoveryClient();
    const close = vi.spyOn(client, "close");
    const lease = await acquireCodexToolDiscoveryClient({
      factory: async () => client,
      callerOwnedAttemptClient,
      options: {},
      timeoutMs: 500,
      signal,
      onTimeout: vi.fn(),
    });
    lease.release();
    lease.release();
    expect(close).toHaveBeenCalledTimes(callerOwnedAttemptClient ? 1 : 0);
  },
);

describe("same-connection Codex discovery membership", () => {
  it("paginates only the supplied request and compares native model, including hidden rows", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ ...createModelFixture("catalog-alias"), model: "different-model" }],
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        data: [{ ...createModelFixture("catalog-id"), model: "native-model", hidden: true }],
        nextCursor: null,
      });
    await expect(
      isCodexModelListedOnConnection({ request, model: "native-model", signal }),
    ).resolves.toBe(true);
    expect(request.mock.calls).toEqual([
      [{ method: "model/list", requestParams: { limit: null, cursor: null, includeHidden: true } }],
      [
        {
          method: "model/list",
          requestParams: { limit: null, cursor: "next", includeHidden: true },
        },
      ],
    ]);
  });

  it.each(["catalog-id", "display-alias", "provider/native-model"])(
    "does not infer membership from %s",
    async (model) => {
      const request = vi.fn().mockResolvedValue({
        data: [
          {
            ...createModelFixture("catalog-id"),
            model: "native-model",
            displayName: "display-alias",
          },
        ],
      });
      await expect(isCodexModelListedOnConnection({ request, model, signal })).resolves.toBe(false);
    },
  );

  it("uses a positive truncated page but fails closed when membership remains unknown", async () => {
    const request = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    await expect(
      isCodexModelListedOnConnection({ request, model: "native-model", signal }),
    ).resolves.toBe(false);
    request.mockResolvedValue({ data: [createModelFixture("other-model")], nextCursor: "more" });
    await expect(
      isCodexModelListedOnConnection({ request, model: "native-model", signal }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(21);
    request.mockResolvedValue({ data: [createModelFixture("native-model")], nextCursor: "more" });
    await expect(
      isCodexModelListedOnConnection({ request, model: "native-model", signal }),
    ).resolves.toBe(true);
  });

  it("does not turn cancellation into a direct retry", async () => {
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const request = vi.fn(async () => {
      abort.abort(reason);
      throw reason;
    });
    await expect(
      isCodexModelListedOnConnection({ request, model: "native-model", signal: abort.signal }),
    ).rejects.toBe(reason);
  });
});

it("bounds a hanging owned acquisition and retires its late result", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<CodexAppServerClient>();
  const fixture = createDiscoveryClient();
  const close = vi.spyOn(fixture.client, "closeAndWait");
  const onTimeout = vi.fn();
  const factory = vi.fn(() => pending.promise);
  const result = acquireCodexToolDiscoveryClient({
    factory,
    callerOwnedAttemptClient: true,
    options: {},
    timeoutMs: 5,
    signal,
    onTimeout,
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({
    code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
    reason: "timed_out",
  });
  expect(onTimeout).toHaveBeenCalledOnce();
  pending.resolve(fixture.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(close).toHaveBeenCalledOnce();
});

it.each(["timeout", "cancel"])(
  "preserves a borrowed late acquisition result after %s",
  async (ending) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = createDeferred<CodexAppServerClient>();
    const { client } = createDiscoveryClient();
    const close = vi.spyOn(client, "close");
    const closeAndWait = vi.spyOn(client, "closeAndWait");
    const result = acquireCodexToolDiscoveryClient({
      factory: async () => pending.promise,
      callerOwnedAttemptClient: false,
      options: {},
      timeoutMs: 5,
      signal: abort.signal,
      onTimeout: vi.fn(),
    }).catch((error: unknown) => error);
    if (ending === "timeout") {
      await vi.advanceTimersByTimeAsync(5);
    } else {
      abort.abort();
    }
    expect(await result).toMatchObject({
      code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
      reason: ending === "timeout" ? "timed_out" : "aborted",
    });
    pending.resolve(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).not.toHaveBeenCalled();
    expect(closeAndWait).not.toHaveBeenCalled();
  },
);

it.each([
  { ending: "failure", callerOwned: false },
  { ending: "cancel", callerOwned: false },
  { ending: "late-started", callerOwned: false },
  { ending: "failure", callerOwned: true },
  { ending: "late-started", callerOwned: true },
])(
  "settles a started callback on $ending according to custody (owned: $callerOwned)",
  async ({ ending, callerOwned }) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const pending = createDeferred<CodexAppServerClient>();
    const started = createDeferred<(client: CodexAppServerClient) => void>();
    const { client } = createDiscoveryClient();
    const close = vi.spyOn(client, "close");
    const closeAndWait = vi.spyOn(client, "closeAndWait");
    const failure = new Error("factory failed after reporting its client");
    const result = acquireCodexToolDiscoveryClient({
      factory: async (options) => {
        if (!options?.onStartedClient) {
          throw new Error("missing startup callback");
        }
        started.resolve(options.onStartedClient);
        return pending.promise;
      },
      callerOwnedAttemptClient: callerOwned,
      options: {},
      timeoutMs: 500,
      signal: abort.signal,
      onTimeout: vi.fn(),
    }).catch((error: unknown) => error);
    const onStarted = await started.promise;
    if (ending !== "late-started") {
      onStarted(client);
    }
    if (ending === "failure") {
      pending.reject(failure);
      expect(await result).toBe(failure);
    } else {
      abort.abort();
      expect(await result).toMatchObject({ reason: "aborted" });
      if (ending === "late-started") {
        onStarted(client);
      }
      pending.reject(failure);
    }
    expect(close).not.toHaveBeenCalled();
    expect(closeAndWait).toHaveBeenCalledTimes(callerOwned ? 1 : 0);
  },
);

it("cancels pending acquisition without starting a second client", async () => {
  const abort = new AbortController();
  const factory = vi.fn(() => new Promise<CodexAppServerClient>(() => {}));
  const result = acquireCodexToolDiscoveryClient({
    factory,
    options: {},
    timeoutMs: 500,
    signal: abort.signal,
    onTimeout: vi.fn(),
  });
  abort.abort();
  await expect(result).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
    reason: "aborted",
  });
  expect(factory).toHaveBeenCalledOnce();
});
