import { describe, expect, it, vi } from "vitest";
import type { ZaloFetch } from "./api.js";
import type { ResolvedZaloAccount } from "./types.js";

vi.mock("./runtime.js", () => ({
  getZaloRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
}));

import { monitorZaloProvider } from "./monitor.js";

function createAbortablePollingFetch(): ZaloFetch {
  return async (input, init) => {
    if (input.endsWith("/deleteWebhook")) {
      return new Response(JSON.stringify({ ok: true, result: true }));
    }
    if (input.endsWith("/getUpdates")) {
      return await new Promise<Response>((_resolve, reject) => {
        const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(abortError);
          },
          { once: true },
        );
      });
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  };
}

function createAccount(): ResolvedZaloAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "token",
    tokenSource: "config",
    config: {},
  };
}

describe("zalo monitor lifecycle", () => {
  it("keeps polling provider alive until abort", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorZaloProvider({
      token: "token",
      account: createAccount(),
      config: {},
      runtime: {},
      abortSignal: abortController.signal,
      fetcher: createAbortablePollingFetch(),
    });

    const pendingBeforeAbort = await Promise.race([
      monitorPromise.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(pendingBeforeAbort).toBe("pending");

    abortController.abort();
    await expect(monitorPromise).resolves.toEqual({ stop: expect.any(Function) });
  });
});
