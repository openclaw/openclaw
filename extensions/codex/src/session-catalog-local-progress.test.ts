import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, expect, it, vi } from "vitest";
import { observe } from "./session-catalog-list-operation.test-support.js";
import { catalogFactory, catalogProvider } from "./session-catalog-resident.test-support.js";
import { commandRpcMocks, config, idleThread } from "./session-catalog.test-helpers.js";

beforeAll(async () => {
  // Keep paired-node module loading outside the local-page fake-timer measurement.
  await import("./session-catalog-node-continue.js");
});

function fixture(partial: boolean) {
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
  const result = observe(list(partial));
  return { started, response, reply, list, onHost, publications, controller, result };
}

it.each([
  [true, "success"],
  [false, "success"],
  [true, "error"],
  [true, "abort"],
] as const)(
  "publishes cold local progress (partial: %s, outcome: %s)",
  async (partial, outcome) => {
    const f = fixture(partial);
    try {
      await f.started.promise;
      await vi.advanceTimersByTimeAsync(250);
      if (outcome === "success") {
        expect.soft(f.result.state.settled).toBe(partial);
      } else {
        expect(f.result.state.settled).toBe(true);
      }
      expect(f.onHost).not.toHaveBeenCalled();
      if (f.result.state.settled) {
        await expect(f.result.done).resolves.toMatchObject({
          status: "fulfilled",
          value: [{ hostId: "gateway:local", connected: true, pending: true, sessions: [] }],
        });
      }
      if (outcome === "success") {
        await vi.advanceTimersByTimeAsync(1_750);
        f.reply();
      } else {
        const error = new Error("catalog interrupted");
        if (outcome === "abort") {
          f.controller.abort(error);
          f.reply();
        } else {
          f.response.reject(error);
        }
      }
      await f.result.done;
      await Promise.all(f.publications);
      expect(f.onHost).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(
          outcome === "success"
            ? { sessions: [expect.objectContaining({ threadId: "cold-row" })] }
            : {
                connected: false,
                sessions: [],
                error: {
                  code: "APP_SERVER_UNAVAILABLE",
                  message: "Codex app-server is unavailable on this host",
                },
              },
        ),
      );
      if (outcome === "success") {
        expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
        commandRpcMocks.codexControlRequest.mockClear();
        await expect(f.list()).resolves.toMatchObject([
          { sessions: [{ threadId: "cold-row" }], connected: true },
        ]);
        expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
      }
    } finally {
      f.reply();
      await f.result.done;
      await Promise.allSettled(f.publications);
      vi.useRealTimers();
    }
  },
);
