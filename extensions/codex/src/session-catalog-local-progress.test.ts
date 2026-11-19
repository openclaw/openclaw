import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, expect, it, vi } from "vitest";
import { catalogFactory, catalogProvider } from "./session-catalog-resident.test-support.js";
import { commandRpcMocks, config, idleThread } from "./session-catalog.test-helpers.js";

beforeAll(async () => {
  // Keep module loading outside the local-page fake-timer measurement.
  await import("./session-catalog-node-continue.js");
});

it.each([
  [true, "success"],
  [false, "success"],
  [true, "error"],
  [true, "abort"],
] as const)(
  "publishes cold local progress (partial: %s, outcome: %s)",
  async (partial, outcome) => {
    const provider = catalogProvider(catalogFactory({ getRuntimeConfig: () => config }));
    const started = createDeferred<void>();
    const response = createDeferred<unknown>();
    commandRpcMocks.codexControlRequest.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const onHost = vi.fn();
    const controller = new AbortController();
    const publications: Promise<void>[] = [];
    const list = (allowPartialResults = true) =>
      provider.list({
        agentId: "main",
        limitPerHost: 1,
        allowPartialResults,
        signal: controller.signal,
        onHost,
        waitUntil: (completion) => publications.push(completion),
      });
    const reply = () =>
      response.resolve({
        data: [idleThread({ id: "cold-row", source: "cli", originator: "codex_cli_rs" })],
        nextCursor: null,
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const settled = vi.fn();
    const result = list(partial);
    void result.then(settled, settled);
    try {
      await started.promise;
      await vi.advanceTimersByTimeAsync(250);
      (outcome === "success" ? expect.soft(settled) : expect(settled)).toHaveBeenCalledTimes(
        Number(partial),
      );
      expect(onHost).not.toHaveBeenCalled();
      if (settled.mock.calls.length) {
        await expect(result).resolves.toMatchObject([
          { hostId: "gateway:local", connected: true, pending: true, sessions: [] },
        ]);
      }
      const error = new Error("catalog interrupted");
      if (outcome === "success") {
        await vi.advanceTimersByTimeAsync(1_750);
        reply();
      } else if (outcome === "abort") {
        controller.abort(error);
        reply();
      } else {
        response.reject(error);
      }
      await result;
      await Promise.all(publications);
      const expectedHost =
        outcome === "success"
          ? { sessions: [{ threadId: "cold-row" }] }
          : { connected: false, sessions: [], error: { code: "APP_SERVER_UNAVAILABLE" } };
      expect(onHost.mock.calls).toMatchObject([[expectedHost]]);
      if (outcome === "success") {
        commandRpcMocks.codexControlRequest.mockClear();
        await expect(list()).resolves.toMatchObject([
          { sessions: [{ threadId: "cold-row" }], connected: true },
        ]);
        expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
      }
    } finally {
      reply();
      await result.catch(() => undefined);
      await Promise.allSettled(publications);
      vi.useRealTimers();
    }
  },
);
