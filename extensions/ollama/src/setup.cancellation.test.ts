// This suite owns wizard-to-discovery cancellation. Context-enrichment
// cancellation stays in setup-model-selection.test.ts: the default enrichment
// path is separate from the wizard's tool inspection.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptAndConfigureOllama } from "./setup.js";
import { createLocalPrompter } from "./setup.test-support.js";

function abortReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted", { cause: signal.reason });
}

describe("Ollama setup cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["local-only", "cloud-local"] as const)(
    "aborts pending %s model discovery with the setup session",
    async (mode) => {
      const controller = new AbortController();
      let rejectPendingFetch!: (reason: Error) => void;
      let requestSignal: AbortSignal | undefined;
      const tagsStarted = createDeferred<void>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (!requestUrl(input).endsWith("/api/tags")) {
            throw new Error(`Unexpected fetch: ${requestUrl(input)}`);
          }
          tagsStarted.resolve();
          return await new Promise<Response>((_resolve, reject) => {
            rejectPendingFetch = reject;
            const signal = init?.signal;
            requestSignal = signal ?? undefined;
            if (!signal) {
              reject(new Error("expected model discovery abort signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), {
              once: true,
            });
          });
        }),
      );

      const setup = promptAndConfigureOllama({
        cfg: {},
        env: {},
        prompter: createLocalPrompter({
          select: vi.fn().mockResolvedValueOnce(mode),
        }),
        signal: controller.signal,
      });
      await tagsStarted.promise;
      controller.abort();

      try {
        expect(requestSignal?.aborted).toBe(true);
        await expect(setup).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        rejectPendingFetch(new Error("Ollama test completed"));
        await setup.catch(() => undefined);
      }
    },
  );
});
