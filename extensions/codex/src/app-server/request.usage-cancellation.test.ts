import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createIsolatedCodexAppServerClient } = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient: vi.fn(),
  isCodexAppServerStartSelectionChangedError: () => false,
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

// Prepare the deferred runtime dependency before testing controlled cancellation.
await import("./sandbox-guard.js");
const { CodexAppServerScopedRequestRejectedError, readCodexAppServerUsage } =
  await import("./request.js");

describe("Codex usage cancellation", () => {
  beforeEach(() => {
    createIsolatedCodexAppServerClient.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("does not acquire a usage client after its owner has aborted", async () => {
    const reason = new Error("Usage deadline exhausted");
    createIsolatedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async () => ({})),
      closeAndWait: vi.fn(async () => undefined),
    });

    await expect(
      readCodexAppServerUsage({ timeoutMs: 3_500, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(createIsolatedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each(["acquisition", "request"] as const)(
    "aborts usage %s when the outer deadline expires",
    async (phase) => {
      const controller = new AbortController();
      const reason = new Error("Usage deadline exhausted");
      const started = createDeferred<AbortSignal>();
      const closed = createDeferred<void>();
      const operation = createDeferred<never>();
      const untilAbort = (signal: AbortSignal) => {
        started.resolve(signal);
        signal.addEventListener("abort", () => operation.reject(signal.reason), { once: true });
        return operation.promise;
      };
      const request = vi.fn((_method: string, _params: unknown, options: { signal: AbortSignal }) =>
        untilAbort(options.signal),
      );
      const closeAndWait = vi.fn(async () => closed.resolve());
      createIsolatedCodexAppServerClient.mockImplementation(
        async ({ abandonSignal }: { abandonSignal: AbortSignal }) =>
          phase === "acquisition" ? await untilAbort(abandonSignal) : { request, closeAndWait },
      );

      const result = readCodexAppServerUsage({ timeoutMs: 3_500, signal: controller.signal });
      const settledError = result.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        const producerSignal = await Promise.race([
          started.promise,
          settledError.then((error) => {
            throw error instanceof Error
              ? error
              : new CodexAppServerScopedRequestRejectedError(
                  "Usage completed without starting its producer",
                  { cause: error },
                );
          }),
        ]);
        controller.abort(reason);
        expect(producerSignal.aborted).toBe(true);
        expect(producerSignal.reason).toBe(reason);
        expect(await settledError).toBe(reason);
        expect(request).toHaveBeenCalledTimes(phase === "request" ? 1 : 0);
        if (phase === "request") {
          await closed.promise;
          expect(closeAndWait).toHaveBeenCalledExactlyOnceWith({
            exitTimeoutMs: 300,
            forceKillDelayMs: 200,
          });
        }
      } finally {
        operation.reject(new Error("Test fixture closed"));
        await Promise.allSettled([operation.promise, settledError]);
      }
    },
  );
});
