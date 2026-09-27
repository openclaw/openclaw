import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaLabServer, startQaProviderServer } = vi.hoisted(() => ({
  startQaLabServer: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("./lab-server.js", () => ({ startQaLabServer }));
vi.mock("./providers/server-runtime.js", () => ({ startQaProviderServer }));

import { runQaLabUiCommand, runQaProviderServerCommand } from "./cli.runtime.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QA CLI server shutdown", () => {
  it.each([
    ["Lab UI", startQaLabServer, () => runQaLabUiCommand({})],
    ["provider", startQaProviderServer, () => runQaProviderServerCommand("mock-openai", {})],
  ] as const)(
    "%s joins the first interrupted shutdown and preserves foreign handlers",
    async (_label, start, run) => {
      for (const mode of ["resolve", "reject", "throw"] as const) {
        const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const signals = ["SIGINT", "SIGTERM"] as const;
        const foreign = vi.fn();
        for (const signal of signals) {
          process.on(signal, foreign);
        }
        const before = {
          SIGINT: process.rawListeners("SIGINT"),
          SIGTERM: process.rawListeners("SIGTERM"),
        };
        const ready = createDeferred<void>();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const failure = new Error("stop failed");
        const exited = new Error("intercepted exit");
        const owned = new Map<string, (...args: unknown[]) => void>();
        const notice = (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === "SIGINT" || event === "SIGTERM") {
            owned.set(event, listener);
          }
          if (owned.size === 2) {
            ready.resolve();
          }
        };
        const stop = vi.fn(() => {
          entered.resolve();
          if (mode === "throw") {
            throw failure;
          }
          return release.promise;
        });
        start.mockResolvedValueOnce({ baseUrl: "http://127.0.0.1:43124", stop });
        process.on("newListener", notice);
        const exit = vi.spyOn(process, "exit").mockImplementation(() => {
          throw exited;
        });
        const settled = vi.fn();
        const action = run();
        const observed = action.then(
          (value) => {
            settled();
            return value;
          },
          (error: unknown) => {
            settled();
            return error;
          },
        );
        try {
          await Promise.race([ready.promise, action]);
          for (const signal of ["SIGINT", "SIGTERM", "SIGINT"]) {
            const listener = owned.get(signal);
            if (!listener) {
              throw new Error(`missing ${signal} handler`);
            }
            listener(signal);
          }
          await entered.promise;
          expect(stop).toHaveBeenCalledOnce();
          expect(stderrWrite).toHaveBeenCalledExactlyOnceWith(
            "Stopping. Interrupt again to exit immediately; cleanup and report completion will be unconfirmed.\n",
          );
          for (const signal of signals) {
            expect(process.rawListeners(signal)).toEqual(before[signal]);
          }
          if (mode !== "throw") {
            expect(settled).not.toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
            if (mode === "reject") {
              release.reject(failure);
            } else {
              release.resolve();
            }
          }
          expect(await observed).toBe(mode === "resolve" ? exited : failure);
          expect(exit.mock.calls).toEqual(mode === "resolve" ? [[0]] : []);
          for (const signal of signals) {
            expect(process.rawListeners(signal)).toEqual(before[signal]);
          }
          expect(foreign).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await observed;
          process.off("newListener", notice);
          for (const signal of signals) {
            const listener = owned.get(signal);
            if (listener) {
              process.off(signal, listener);
            }
            process.off(signal, foreign);
          }
          exit.mockRestore();
          stderrWrite.mockRestore();
        }
      }
    },
  );
});
