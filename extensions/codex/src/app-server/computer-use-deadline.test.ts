import { afterEach, describe, expect, it, vi } from "vitest";
import { installCodexComputerUse } from "./computer-use.js";
import { createClientHarness } from "./test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Computer Use request deadline", () => {
  it.each([0, -120_000, 120_000])("keeps its budget with wall-clock offset %i", async (offset) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_700_000_000_000);
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => 1_700_000_000_000 + (reads++ === 0 ? 0 : offset),
    );
    const harness = createClientHarness();
    const timeouts: Array<number | undefined> = [];
    let requestSettled = false;
    let requestError: unknown;
    const originalRequest = harness.client.request.bind(harness.client);
    vi.spyOn(harness.client, "request").mockImplementation((method, params, options) => {
      timeouts.push(options?.timeoutMs);
      const pending = originalRequest(method, params, options);
      void pending.then(
        () => {
          requestSettled = true;
        },
        (error: unknown) => {
          requestSettled = true;
          requestError = error;
        },
      );
      return pending;
    });
    // A written config mutation can keep install retirement waiting for process exit.
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true } },
      timeoutMs: 1_000,
    }).catch(() => undefined);
    try {
      const firstWrite = await harness.waitForWrite(0);
      expect(JSON.parse(firstWrite).method).toBe("experimentalFeature/enablement/set");
      expect(timeouts).toEqual([1_000]);
      await vi.advanceTimersByTimeAsync(999);
      expect(requestSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(requestSettled).toBe(true);
      expect(requestError).toBeInstanceOf(Error);
      expect(requestError).toHaveProperty("message", expect.stringContaining("timed out"));
    } finally {
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
  });
});
