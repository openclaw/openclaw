import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExchangeRegistry } from "../../src/core/exchange-registry.js";
import type { ExchangeConfig } from "../../src/types.js";

// Mock ccxt to avoid real exchange connections in unit tests.
// ExchangeRegistry uses `new ExchangeClass(opts)` so we need constructable mocks.
vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
  };
});

function makeConfig(overrides?: Partial<ExchangeConfig>): ExchangeConfig {
  return {
    exchange: "binance",
    apiKey: "test-key",
    secret: "test-secret",
    ...overrides,
  };
}

describe("ExchangeRegistry", () => {
  let registry: ExchangeRegistry;

  beforeEach(() => {
    registry = new ExchangeRegistry();
  });

  it("should initialize with empty registry", () => {
    const list = registry.listExchanges();
    expect(list).toEqual([]);
  });

  it("should add exchange config", () => {
    registry.addExchange("main", makeConfig());
    const list = registry.listExchanges();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ id: "main", exchange: "binance", testnet: false });
  });

  it("should list all configured exchanges", () => {
    registry.addExchange("binance-main", makeConfig());
    registry.addExchange("okx-sub", makeConfig({ exchange: "okx" }));
    const list = registry.listExchanges();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.id)).toContain("binance-main");
    expect(list.map((e) => e.id)).toContain("okx-sub");
  });

  it("should get exchange instance by id", async () => {
    registry.addExchange("main", makeConfig());
    const instance = await registry.getInstance("main");
    expect(instance).toBeDefined();
  });

  it("should cache exchange instances (return same object)", async () => {
    registry.addExchange("main", makeConfig());
    const inst1 = await registry.getInstance("main");
    const inst2 = await registry.getInstance("main");
    expect(inst1).toBe(inst2);
  });

  it("should remove exchange by id", () => {
    registry.addExchange("main", makeConfig());
    expect(registry.listExchanges()).toHaveLength(1);

    const removed = registry.removeExchange("main");
    expect(removed).toBe(true);
    expect(registry.listExchanges()).toHaveLength(0);
  });

  it("should return false when removing non-existent exchange", () => {
    const removed = registry.removeExchange("nonexistent");
    expect(removed).toBe(false);
  });

  it("should overwrite config when adding same id again", () => {
    registry.addExchange("main", makeConfig({ exchange: "binance" }));
    registry.addExchange("main", makeConfig({ exchange: "okx" }));

    const list = registry.listExchanges();
    expect(list).toHaveLength(1);
    expect(list[0]!.exchange).toBe("okx");
  });

  it("should handle testnet flag correctly", () => {
    registry.addExchange("test", makeConfig({ testnet: true }));
    const list = registry.listExchanges();
    expect(list[0]!.testnet).toBe(true);
  });

  it("should default testnet to false when not specified", () => {
    registry.addExchange("prod", makeConfig({ testnet: undefined }));
    const list = registry.listExchanges();
    expect(list[0]!.testnet).toBe(false);
  });

  it("should throw for non-existent exchange id on getInstance", async () => {
    await expect(registry.getInstance("missing")).rejects.toThrow(
      /Exchange "missing" not configured/,
    );
  });

  it("should close all exchange connections", async () => {
    registry.addExchange("a", makeConfig());
    registry.addExchange("b", makeConfig({ exchange: "okx" }));
    // Create instances first
    await registry.getInstance("a");
    await registry.getInstance("b");

    await registry.closeAll();
    // After closeAll, the list is still there but instances are cleared.
    // Getting an instance again should create a fresh one.
    expect(registry.listExchanges()).toHaveLength(2);
  });
});
