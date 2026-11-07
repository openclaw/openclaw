// This suite owns wizard-to-discovery cancellation. Context-enrichment
// cancellation stays in setup-model-selection.test.ts: the default enrichment
// path is separate from the wizard's tool inspection.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
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

  it.each([
    { mode: "local-only", pendingPath: "/api/tags" },
    { mode: "cloud-local", pendingPath: "/api/tags" },
    { mode: "cloud-local", pendingPath: "/api/me" },
  ] as const)(
    "aborts pending $mode $pendingPath with the setup session",
    async ({ mode, pendingPath }) => {
      const controller = new AbortController();
      let rejectPendingFetch!: (reason: Error) => void;
      let requestSignal: AbortSignal | undefined;
      const requestStarted = createDeferred<void>();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = requestUrl(input);
          if (!url.endsWith(pendingPath)) {
            if (url.endsWith("/api/tags")) {
              return jsonResponse({ models: [{ name: "setup-tools:latest" }] });
            }
            if (url.endsWith("/api/show")) {
              return jsonResponse({
                model_info: { "model.context_length": 32768 },
                capabilities: ["completion", "tools"],
              });
            }
            throw new Error(`Unexpected fetch: ${url}`);
          }
          requestStarted.resolve();
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
      await requestStarted.promise;
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
