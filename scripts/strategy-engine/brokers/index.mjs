/**
 * brokers/index.mjs — 券商 Adapter 工廠
 * 新增券商只需：
 *   1. 建立 XxxAdapter.mjs extends BrokerAdapter
 *   2. 在此檔 ADAPTERS 加一行
 *   3. 在 config/instrument-registry.json 註冊商品
 */
export { BrokerAdapter } from "./BrokerAdapter.mjs";
export { CapitalAdapter } from "./CapitalAdapter.mjs";
export { OkxAdapter } from "./OkxAdapter.mjs";
export { PaperTradingLoop } from "./PaperTradingLoop.mjs";

// 已註冊的 adapter 工廠
const ADAPTERS = {
  capital: async (opts) => new (await import("./CapitalAdapter.mjs")).CapitalAdapter(opts),
  okx: async (opts) => new (await import("./OkxAdapter.mjs")).OkxAdapter(opts),
  // ib:   async (opts) => new (await import("./IbAdapter.mjs")).IbAdapter(opts),
  // yuanta: async (opts) => new (await import("./YuantaAdapter.mjs")).YuantaAdapter(opts),
  // binance: async (opts) => new (await import("./BinanceAdapter.mjs")).BinanceAdapter(opts),
};

/**
 * 建立 adapter 實例
 * @param {string} name - "capital" | "okx" | "ib" | ...
 * @param {Object} opts - adapter 設定
 * @returns {Promise<BrokerAdapter>}
 */
export async function createAdapter(name, opts = {}) {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(
      "未知券商 adapter: " + name + "（可用: " + Object.keys(ADAPTERS).join(", ") + "）",
    );
  }
  return factory(opts);
}

/** 列出所有已註冊的 adapter 名稱 */
export function listAdapters() {
  return Object.keys(ADAPTERS);
}
