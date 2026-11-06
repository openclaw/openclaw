import { describe, expect, it, vi } from "vitest";

const { startQaLabServer } = vi.hoisted(() => ({
  startQaLabServer: vi.fn(),
}));

// mock-isolation: The synthetic server owns the stop receipt; exclude the QA harness and capture runtime state from this signal test.
vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

import { runQaLabUiCommand } from "./cli-server.runtime.js";

describe("QA server command shutdown", () => {
  it.each([false, true])("settles after the server closes (failure=%s)", async (fails) => {
    const previousInt = process.listeners("SIGINT");
    const previousTerm = process.listeners("SIGTERM");
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const stop = vi.fn(() => {
      entered.resolve();
      return completed.promise;
    });
    startQaLabServer.mockResolvedValue({ baseUrl: "http://qa.invalid", stop });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("forced QA exit");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const command = runQaLabUiCommand({});
    // Observe rejection immediately; cleanup errors belong to the returned command.
    const outcome = command.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.resolve();
      const signal = process
        .listeners("SIGTERM")
        .find((listener) => !previousTerm.includes(listener));
      expect(signal).toBeDefined();
      signal!("SIGTERM");
      await entered.promise;
      signal!("SIGTERM");
      expect(stop).toHaveBeenCalledOnce();
      const failure = new Error("server close failed");
      if (fails) {
        completed.reject(failure);
      } else {
        completed.resolve();
      }
      expect(await outcome).toBe(fails ? failure : undefined);
      expect(process.listeners("SIGINT")).toEqual(previousInt);
      expect(process.listeners("SIGTERM")).toEqual(previousTerm);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      completed.resolve();
      exit.mockRestore();
      stdout.mockRestore();
      for (const [name, previous] of [
        ["SIGINT", previousInt],
        ["SIGTERM", previousTerm],
      ] as const) {
        for (const listener of process.listeners(name)) {
          if (!previous.includes(listener)) {
            process.off(name, listener);
          }
        }
      }
    }
  });
});
