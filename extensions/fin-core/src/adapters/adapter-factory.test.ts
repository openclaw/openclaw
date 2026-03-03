import { describe, expect, it } from "vitest";
import type { ExchangeConfig } from "../types.js";
import { createAdapter } from "./adapter-factory.js";
import { AlpacaAdapter } from "./alpaca-adapter.js";
import { CcxtAdapter } from "./ccxt-adapter.js";
import { FutuAdapter } from "./futu-adapter.js";
import { OpenCtpAdapter } from "./openctp-adapter.js";

/** Minimal mock registry — just needs to exist for construction. */
function mockRegistry() {
  return {
    configs: new Map(),
    instances: new Map(),
    addExchange() {},
    removeExchange() {
      return false;
    },
    listExchanges() {
      return [];
    },
    async getInstance() {
      return {};
    },
    async closeAll() {},
  } as never;
}

describe("createAdapter", () => {
  // ── Crypto (CCXT) ──

  const cryptoExchanges: ExchangeConfig["exchange"][] = ["binance", "okx", "bybit", "hyperliquid"];

  for (const exchange of cryptoExchanges) {
    it(`returns CcxtAdapter for ${exchange}`, () => {
      const config: ExchangeConfig = { exchange, apiKey: "k", secret: "s" };
      const adapter = createAdapter(`${exchange}-test`, config, mockRegistry());
      expect(adapter).toBeInstanceOf(CcxtAdapter);
      expect(adapter.exchangeId).toBe(`${exchange}-test`);
      expect(adapter.marketType).toBe("crypto");
    });
  }

  it("respects testnet flag from config", () => {
    const config: ExchangeConfig = { exchange: "binance", apiKey: "k", secret: "s", testnet: true };
    const adapter = createAdapter("bn-test", config, mockRegistry());
    expect(adapter.isTestnet).toBe(true);
  });

  it("defaults isTestnet to false", () => {
    const config: ExchangeConfig = { exchange: "binance", apiKey: "k", secret: "s" };
    const adapter = createAdapter("bn-main", config, mockRegistry());
    expect(adapter.isTestnet).toBe(false);
  });

  // ── Alpaca (US equity) ──

  it("returns AlpacaAdapter for alpaca", () => {
    const config: ExchangeConfig = { exchange: "alpaca", apiKey: "key-id", secret: "secret-key" };
    const adapter = createAdapter("alpaca-paper", config, mockRegistry());
    expect(adapter).toBeInstanceOf(AlpacaAdapter);
    expect(adapter.exchangeId).toBe("alpaca-paper");
    expect(adapter.marketType).toBe("us-equity");
  });

  it("alpaca defaults to paper mode (isTestnet=true)", () => {
    const config: ExchangeConfig = { exchange: "alpaca", apiKey: "k", secret: "s" };
    const adapter = createAdapter("alp", config, mockRegistry());
    expect(adapter.isTestnet).toBe(true); // paper=true by default
  });

  it("alpaca respects paper=false for live mode", () => {
    const config: ExchangeConfig = { exchange: "alpaca", apiKey: "k", secret: "s", paper: false };
    const adapter = createAdapter("alp-live", config, mockRegistry());
    expect(adapter.isTestnet).toBe(false);
  });

  it("alpaca throws when credentials missing", () => {
    const config: ExchangeConfig = { exchange: "alpaca", apiKey: "", secret: "" };
    expect(() => createAdapter("alp", config, mockRegistry())).toThrow(/apiKey and secret/);
  });

  // ── Futu (HK equity) ──

  it("returns FutuAdapter for futu", () => {
    const config: ExchangeConfig = { exchange: "futu", apiKey: "k", secret: "s", host: "127.0.0.1", port: 11111 };
    const adapter = createAdapter("futu-main", config, mockRegistry());
    expect(adapter).toBeInstanceOf(FutuAdapter);
    expect(adapter.exchangeId).toBe("futu-main");
    expect(adapter.marketType).toBe("hk-equity");
  });

  it("futu defaults testnet to false", () => {
    const config: ExchangeConfig = { exchange: "futu", apiKey: "k", secret: "s" };
    const adapter = createAdapter("futu", config, mockRegistry());
    expect(adapter.isTestnet).toBe(false);
  });

  // ── OpenCTP (CN A-share) ──

  it("returns OpenCtpAdapter for openctp", () => {
    const config: ExchangeConfig = {
      exchange: "openctp",
      apiKey: "investor-id",
      secret: "password",
      ctpFrontAddr: "tcp://180.168.146.187:10130",
      ctpBrokerId: "9999",
      ctpAppId: "simnow_client_test",
      ctpAuthCode: "0000000000000000",
    };
    const adapter = createAdapter("openctp-sim", config, mockRegistry());
    expect(adapter).toBeInstanceOf(OpenCtpAdapter);
    expect(adapter.exchangeId).toBe("openctp-sim");
    expect(adapter.marketType).toBe("cn-a-share");
  });

  it("openctp defaults to testnet (SimNow)", () => {
    const config: ExchangeConfig = {
      exchange: "openctp",
      apiKey: "inv",
      secret: "pwd",
      ctpFrontAddr: "tcp://180.168.146.187:10130",
      ctpBrokerId: "9999",
    };
    const adapter = createAdapter("ctp", config, mockRegistry());
    expect(adapter.isTestnet).toBe(true);
  });

  it("openctp uses custom bridge url from host:port", () => {
    const config: ExchangeConfig = {
      exchange: "openctp",
      apiKey: "inv",
      secret: "pwd",
      ctpFrontAddr: "tcp://180.168.146.187:10130",
      ctpBrokerId: "9999",
      host: "192.168.1.100",
      port: 8080,
    };
    const adapter = createAdapter("ctp-custom", config, mockRegistry());
    expect(adapter).toBeInstanceOf(OpenCtpAdapter);
  });

  it("openctp throws when ctpFrontAddr missing", () => {
    const config: ExchangeConfig = { exchange: "openctp", apiKey: "k", secret: "s" };
    expect(() => createAdapter("ctp", config, mockRegistry())).toThrow(/ctpFrontAddr and ctpBrokerId/);
  });

  it("openctp throws when ctpBrokerId missing", () => {
    const config: ExchangeConfig = {
      exchange: "openctp",
      apiKey: "k",
      secret: "s",
      ctpFrontAddr: "tcp://180.168.146.187:10130",
    };
    expect(() => createAdapter("ctp", config, mockRegistry())).toThrow(/ctpFrontAddr and ctpBrokerId/);
  });

  // ── Unsupported ──

  it("throws for unsupported exchange type", () => {
    const config = { exchange: "interactive-brokers" as ExchangeConfig["exchange"], apiKey: "k", secret: "s" };
    expect(() => createAdapter("ib", config, mockRegistry())).toThrow(/Unsupported exchange/);
  });
});
