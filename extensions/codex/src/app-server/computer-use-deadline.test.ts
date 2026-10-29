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

describe("Computer Use marketplace discovery deadline", () => {
  it.each([-120_000, 120_000])("keeps its budget after a %i ms wall-clock step", async (offset) => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.id === undefined) {
          return;
        }
        send({
          id: message.id,
          result:
            message.method === "experimentalFeature/list"
              ? { data: [{ name: "plugins", enabled: true }] }
              : message.method === "plugin/list"
                ? { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
                : {},
        });
      },
    });
    let settled = false;
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true, marketplaceDiscoveryTimeoutMs: 4_000 } },
      timeoutMs: 30_000,
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        harness.writes.some(
          (line) => (JSON.parse(line) as { method?: string }).method === "plugin/list",
        ),
      ).toBe(true);
      vi.setSystemTime(Date.now() + offset);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await operation).toMatchObject({
        name: "CodexComputerUseSetupError",
        status: { reason: "marketplace_missing" },
      });
    } finally {
      controller.abort();
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
  });
});
