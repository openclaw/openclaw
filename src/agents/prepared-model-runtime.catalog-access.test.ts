import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  resolvePreparedModelCatalogForegroundWaitMs,
  waitForPreparedModelCatalogForeground,
} from "./prepared-model-runtime.catalog-foreground-wait.js";

const stale: ModelCatalogSnapshot = {
  entries: [],
  routeVariants: [],
  authoritative: false,
};
const ready: ModelCatalogSnapshot = {
  entries: [{ provider: "demo", id: "native-model", name: "Native model" }],
  routeVariants: [],
  authoritative: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("prepared model catalog foreground wait", () => {
  it("keeps the ordinary picker wait at five seconds", async () => {
    vi.useFakeTimers();
    let resolveAcquisition!: (catalog: ModelCatalogSnapshot) => void;
    const acquisition = new Promise<ModelCatalogSnapshot>((resolve) => {
      resolveAcquisition = resolve;
    });
    const waitMs = resolvePreparedModelCatalogForegroundWaitMs();
    expect(waitMs).toBe(5_000);
    let settled = false;
    const result = waitForPreparedModelCatalogForeground({
      acquisition,
      waitMs,
      fallback: () => stale,
    }).then((catalog) => {
      settled = true;
      return catalog;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(stale);
    resolveAcquisition(ready);
  });

  it("allows one caller to wait up to twelve seconds for the same acquisition", async () => {
    vi.useFakeTimers();
    let resolveAcquisition!: (catalog: ModelCatalogSnapshot) => void;
    const acquisition = new Promise<ModelCatalogSnapshot>((resolve) => {
      resolveAcquisition = resolve;
    });
    const waitMs = resolvePreparedModelCatalogForegroundWaitMs(12_000);
    expect(waitMs).toBe(12_000);
    expect(resolvePreparedModelCatalogForegroundWaitMs(60_000)).toBe(12_000);
    const result = waitForPreparedModelCatalogForeground({
      acquisition,
      waitMs,
      fallback: () => stale,
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(settled).toBe(false);
    resolveAcquisition(ready);
    await expect(result).resolves.toBe(ready);
  });
});
