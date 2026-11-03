import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installCodexComputerUse } from "./computer-use.js";
import { createClientHarness } from "./test-support.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ["request", 0],
  ["request", -120_000],
  ["request", 120_000],
  ["discovery", -120_000],
  ["discovery", 120_000],
] as const)("keeps the %s budget with wall-clock offset %i", async (kind, offset) => {
  const discovery = kind === "discovery";
  const budget = discovery ? 4_000 : 1_000;
  if (!discovery) {
    vi.setSystemTime(1_700_000_000_000);
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => 1_700_000_000_000 + (reads++ === 0 ? 0 : offset),
    );
  }
  const harness = createClientHarness(
    discovery
      ? {
          onWrite: (line, send) => {
            const message = JSON.parse(line) as { id?: unknown; method?: string };
            if (message.id !== undefined) {
              send({
                id: message.id,
                result:
                  message.method === "experimentalFeature/list"
                    ? { data: [{ name: "plugins", enabled: true }] }
                    : message.method === "plugin/list"
                      ? { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
                      : {},
              });
            }
          },
        }
      : undefined,
  );
  const controller = new AbortController();
  const settled = vi.fn<(result: unknown) => void>();
  const request = vi.spyOn(harness.client, "request");
  const operation = installCodexComputerUse({
    client: harness.client,
    pluginConfig: {
      computerUse: {
        autoInstall: true,
        ...(discovery ? { marketplaceDiscoveryTimeoutMs: budget } : {}),
      },
    },
    timeoutMs: discovery ? 30_000 : budget,
    signal: discovery ? controller.signal : undefined,
  }).catch((error: unknown) => error);
  try {
    if (discovery) {
      void operation.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.writes.some((line) => JSON.parse(line).method === "plugin/list")).toBe(true);
      vi.setSystemTime(Date.now() + offset);
    } else {
      const firstWrite = await harness.waitForWrite(0);
      expect(JSON.parse(firstWrite).method).toBe("experimentalFeature/enablement/set");
      // A written mutation may await process retirement after its request deadline.
      void request.mock.results[0]?.value.then(settled, settled);
    }
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(discovery ? 1 : 2);
    expect(settled).toHaveBeenCalledOnce();
    const error = settled.mock.calls[0]?.[0];
    if (discovery) {
      expect(error).toMatchObject({
        name: "CodexComputerUseSetupError",
        status: { reason: "marketplace_missing" },
      });
    } else {
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", expect.stringContaining("timed out"));
    }
  } finally {
    controller.abort();
    harness.client.close();
    harness.process.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    await operation;
  }
});
