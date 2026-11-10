import { afterEach, describe, expect, it, vi } from "vitest";

const mockStopBrowserBridgeServer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: mockStopBrowserBridgeServer,
}));

import {
  BROWSER_BRIDGES,
  stopOneShotBrowserBridges,
  trackOneShotBrowserBridge,
  withOneShotBrowserBridgeScope,
  type CachedBrowserBridge,
} from "./browser-bridges.js";

function add(key: string): CachedBrowserBridge {
  const bridge = {
    bridge: { server: { id: key } },
    containerName: key,
  } as unknown as CachedBrowserBridge;
  BROWSER_BRIDGES.set(key, bridge);
  trackOneShotBrowserBridge(key, bridge);
  return bridge;
}

afterEach(() => {
  BROWSER_BRIDGES.clear();
  vi.resetAllMocks();
});

describe("one-shot sandbox browser ownership", () => {
  it("closes only bridges created inside the scoped run", async () => {
    const existing = add("existing");
    await withOneShotBrowserBridgeScope(async () => {
      add("new");
      await stopOneShotBrowserBridges();
    });
    expect(mockStopBrowserBridgeServer).toHaveBeenCalledOnce();
    expect(BROWSER_BRIDGES.get("existing")).toBe(existing);
    expect(BROWSER_BRIDGES.has("new")).toBe(false);
  });

  it("closes a new generation and preserves unrelated entries", async () => {
    const previous = add("replaced");
    const unchanged = add("unchanged");
    await withOneShotBrowserBridgeScope(async () => {
      const current = add("replaced");
      expect(current).not.toBe(previous);
      await stopOneShotBrowserBridges();
    });
    expect(BROWSER_BRIDGES.has("replaced")).toBe(false);
    expect(BROWSER_BRIDGES.get("unchanged")).toBe(unchanged);
  });

  it("preserves a replacement installed while a stop is in flight", async () => {
    await withOneShotBrowserBridgeScope(async () => {
      const original = add("target");
      const replacement = { ...original };
      mockStopBrowserBridgeServer.mockImplementationOnce(async () => {
        BROWSER_BRIDGES.set("target", replacement);
      });
      await stopOneShotBrowserBridges();
      expect(BROWSER_BRIDGES.get("target")).toBe(replacement);
    });
  });

  it("does not close a bridge owned by another concurrent run", async () => {
    let signalReady: () => void = () => {};
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });

    const otherRun = withOneShotBrowserBridgeScope(async () => {
      const foreign = add("foreign");
      signalReady();
      await waiting;
      await stopOneShotBrowserBridges();
      return foreign;
    });

    await ready;
    await withOneShotBrowserBridgeScope(async () => {
      add("ours");
      await stopOneShotBrowserBridges();
    });
    expect(BROWSER_BRIDGES.has("ours")).toBe(false);
    expect(BROWSER_BRIDGES.has("foreign")).toBe(true);
    release();
    await otherRun;
    expect(BROWSER_BRIDGES.size).toBe(0);
    expect(mockStopBrowserBridgeServer).toHaveBeenCalledTimes(2);
  });

  it("attempts every cleanup and propagates failures", async () => {
    await withOneShotBrowserBridgeScope(async () => {
      add("first");
      add("second");
      mockStopBrowserBridgeServer.mockRejectedValue(new Error("close failed"));
      await expect(stopOneShotBrowserBridges()).rejects.toThrow(
        "Failed to stop one-shot sandbox browser bridges",
      );
      expect(mockStopBrowserBridgeServer).toHaveBeenCalledTimes(2);
    });
  });

  it("does nothing if the run opened no browser", async () => {
    await withOneShotBrowserBridgeScope(stopOneShotBrowserBridges);
    expect(mockStopBrowserBridgeServer).not.toHaveBeenCalled();
  });
});
