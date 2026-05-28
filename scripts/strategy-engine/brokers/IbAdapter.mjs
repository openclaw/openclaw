// IbAdapter.mjs — Interactive Brokers TWS API 串接
// 依賴套件：@stoqey/ib（純 JS IB TWS/Gateway API，不需要 Java）
//
// 安裝：npm install @stoqey/ib
// 需要先啟動：TWS 或 IB Gateway（紙上交易或實盤帳號）
//             設定 → API → Settings → Enable ActiveX and Socket Clients
//             Socket port 預設 7496 (TWS) / 4001 (Gateway)
//
// 功能：
//   1. 連線管理（自動重連）
//   2. 行情訂閱（即時報價 + K 棒）
//   3. 下單（市價/限價/停損）
//   4. 部位查詢
//   5. 帳戶資訊

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// 動態 require（避免未安裝時整個系統崩潰）
let IBApi, EventName, OrderAction, OrderType, SecType;
try {
  const ib = require("@stoqey/ib");
  IBApi = ib.IBApi;
  EventName = ib.EventName;
  OrderAction = ib.OrderAction;
  OrderType = ib.OrderType;
  SecType = ib.SecType;
} catch {
  // 未安裝時使用 mock（允許系統其他部分正常運作）
}

import { EventEmitter } from "node:events";
import { getSpec } from "./ContractSpecs.mjs";

// ── IB Contract 建構工具 ─────────────────────────────────────────
/**
 * 依商品代碼建立 IB Contract 物件
 * @param {string} symbol     如 'ES', 'NQ', 'GC', 'CL'
 * @param {string} expiry     如 '20250321' 或 '202503'
 * @param {string} exchange   如 'CME', 'NYMEX', 'COMEX' (可從 ContractSpecs 自動取得)
 */
export function buildContract(symbol, expiry = "", exchange = "") {
  const spec = getSpec(symbol);
  const exch = exchange || spec?.exchange || "SMART";
  const curr = spec?.currency || "USD";

  return {
    symbol: symbol.toUpperCase(),
    secType: SecType?.FUT ?? "FUT",
    exchange: exch,
    currency: curr,
    lastTradeDateOrContractMonth: expiry,
    multiplier: String(spec?.pointValue ?? 1),
  };
}

// ── IbAdapter 主類別 ──────────────────────────────────────────────
export class IbAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.host         TWS/Gateway 主機（預設 '127.0.0.1'）
   * @param {number}  opts.port         埠（7496=TWS, 4001=Gateway，預設 7496）
   * @param {number}  opts.clientId     客戶端 ID（不同程式用不同 ID，預設 1）
   * @param {boolean} opts.paper        是否為紙上交易（僅供記錄，不影響連線）
   * @param {number}  opts.reconnectMs  斷線後重連延遲 ms（預設 5000）
   * @param {object}  opts.logger       LogManager 實例（可選）
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 7496;
    this.clientId = opts.clientId ?? 1;
    this.paper = opts.paper ?? true;
    this.reconnectMs = opts.reconnectMs ?? 5000;
    this.logger = opts.logger ?? null;

    this._ib = null;
    this._connected = false;
    this._reqId = 1; // 遞增請求 ID
    this._subscriptions = new Map(); // reqId → { symbol, callback }
    this._pendingOrders = new Map(); // orderId → { signal, resolve, reject }
    this._positions = new Map(); // symbol → { qty, avgPrice, unrealizedPnl }
    this._account = {}; // 帳戶資訊
    this._orderIdNext = 1;
  }

  // ── 連線 ──────────────────────────────────────────────────────
  connect() {
    if (!IBApi) {
      this._log("error", "@stoqey/ib 未安裝，請執行: npm install @stoqey/ib");
      this.emit("error", new Error("@stoqey/ib not installed"));
      return;
    }

    this._log(
      "info",
      `連線 IB TWS ${this.host}:${this.port} clientId=${this.clientId}${this.paper ? " [紙上交易]" : " [實盤]"}`,
    );

    this._ib = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });

    // ── 連線事件 ─────────────────────────────────────────
    this._ib.on(EventName.connected, () => {
      this._connected = true;
      this._log("info", "IB TWS 已連線");
      this.emit("connected");
      this._ib.reqCurrentTime();
      this._ib.reqAccountSummary(
        this._nextReqId(),
        "All",
        "NetLiquidation,TotalCashValue,GrossPositionValue,UnrealizedPnL,RealizedPnL,AvailableFunds",
      );
      this._ib.reqPositions();
    });

    this._ib.on(EventName.disconnected, () => {
      this._connected = false;
      this._log("warn", "IB TWS 斷線，嘗試重連...");
      this.emit("disconnected");
      setTimeout(() => this.connect(), this.reconnectMs);
    });

    this._ib.on(EventName.error, (err, code, reqId) => {
      // IB 有些 error code 是非嚴重警告（如 2104=行情農場連線）
      const WARN_CODES = [2103, 2104, 2105, 2106, 2107, 2119, 2158];
      if (WARN_CODES.includes(code)) {
        this._log("debug", `IB 非嚴重警告 code=${code}: ${err?.message ?? err}`);
        return;
      }
      this._log("error", `IB 錯誤 code=${code} reqId=${reqId}: ${err?.message ?? err}`);
      this.emit("ib_error", { code, reqId, error: err });
    });

    // ── 行情事件 ─────────────────────────────────────────
    this._ib.on(EventName.tickPrice, (reqId, tickType, price, _attribs) => {
      const sub = this._subscriptions.get(reqId);
      if (!sub) {
        return;
      }
      // tickType: 1=BID, 2=ASK, 4=LAST, 6=HIGH, 7=LOW, 9=CLOSE
      const tickMap = {
        1: "bid",
        2: "ask",
        4: "last",
        6: "high",
        7: "low",
        9: "close",
        14: "open",
      };
      const field = tickMap[tickType];
      if (field) {
        sub.tick = sub.tick || {};
        sub.tick[field] = price;
        sub.callback?.({ symbol: sub.symbol, type: "tick", ...sub.tick });
        this.emit("tick", { symbol: sub.symbol, ...sub.tick });
      }
    });

    this._ib.on(EventName.tickSize, (reqId, tickType, size) => {
      const sub = this._subscriptions.get(reqId);
      if (!sub) {
        return;
      }
      const sizeMap = { 0: "bidSize", 3: "askSize", 5: "lastSize", 8: "volume" };
      const field = sizeMap[tickType];
      if (field) {
        sub.tick = sub.tick || {};
        sub.tick[field] = size;
      }
    });

    // ── 即時 K 棒 ────────────────────────────────────────
    this._ib.on(
      EventName.realtimeBar,
      (reqId, time, open, high, low, close, volume, wap, count) => {
        const sub = this._subscriptions.get(reqId);
        if (!sub) {
          return;
        }
        const bar = {
          time: new Date(time * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume: Number(volume),
          wap: Number(wap),
          count,
        };
        sub.callback?.({ symbol: sub.symbol, type: "bar", bar });
        this.emit("bar", { symbol: sub.symbol, bar });
      },
    );

    // ── 歷史 K 棒 ────────────────────────────────────────
    this._ib.on(EventName.historicalData, (reqId, bar) => {
      const sub = this._subscriptions.get(reqId);
      if (!sub?.bars) {
        return;
      }
      sub.bars.push({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: Number(bar.volume),
      });
    });

    this._ib.on(EventName.historicalDataEnd, (reqId, _start, _end) => {
      const sub = this._subscriptions.get(reqId);
      if (!sub?.resolve) {
        return;
      }
      sub.resolve(sub.bars ?? []);
      this._subscriptions.delete(reqId);
    });

    // ── 下單回報 ─────────────────────────────────────────
    this._ib.on(EventName.orderStatus, (orderId, status, filled, remaining, avgFillPrice) => {
      this._log(
        "debug",
        `訂單 ${orderId} status=${status} filled=${filled} avgPrice=${avgFillPrice}`,
      );
      const pending = this._pendingOrders.get(orderId);
      if (!pending) {
        return;
      }

      if (status === "Filled") {
        this.emit("fill", {
          orderId,
          symbol: pending.signal.instrument,
          direction: pending.signal.direction,
          qty: filled,
          fillPrice: avgFillPrice,
          strategy: pending.signal.strategy,
          ts: new Date().toISOString(),
        });
        pending.resolve({ orderId, filled, avgFillPrice, status });
        this._pendingOrders.delete(orderId);
      } else if (["Cancelled", "ApiCancelled", "Inactive"].includes(status)) {
        pending.reject(new Error(`訂單取消: ${status}`));
        this._pendingOrders.delete(orderId);
      }
    });

    // ── 帳戶資訊 ─────────────────────────────────────────
    this._ib.on(EventName.accountSummary, (reqId, account, tag, value, currency) => {
      this._account[tag] = { value: Number.parseFloat(value) || value, currency };
      this.emit("account", this._account);
    });

    // ── 部位 ─────────────────────────────────────────────
    this._ib.on(EventName.position, (account, contract, pos, avgCost) => {
      const sym = contract.symbol;
      this._positions.set(sym, {
        qty: pos,
        avgPrice: avgCost,
        symbol: sym,
        currency: contract.currency,
      });
      this.emit("position", { symbol: sym, qty: pos, avgPrice: avgCost });
    });

    this._ib.on(EventName.positionEnd, () => {
      this.emit("positions", Object.fromEntries(this._positions));
    });

    // ── nextValidId（IB 要求下單前先取得有效 orderId）──────
    this._ib.on(EventName.nextValidId, (orderId) => {
      this._orderIdNext = orderId;
      this._log("debug", `nextValidId = ${orderId}`);
    });

    this._ib.connect();
  }

  disconnect() {
    this._connected = false;
    this._ib?.disconnect();
  }

  // ── 行情訂閱 ──────────────────────────────────────────────────
  /**
   * 訂閱即時報價（Level 1）
   * @param {string}   symbol   如 'ES'
   * @param {string}   expiry   如 '20250321'
   * @param {Function} callback (tickData) => void
   * @returns {number}  reqId
   */
  subscribeQuote(symbol, expiry, callback) {
    const reqId = this._nextReqId();
    const contract = buildContract(symbol, expiry);
    this._subscriptions.set(reqId, { symbol, callback, tick: {} });
    this._ib.reqMktData(reqId, contract, "", false, false, []);
    this._log("info", `訂閱行情: ${symbol} reqId=${reqId}`);
    return reqId;
  }

  /**
   * 訂閱即時 5 秒 K 棒
   * @param {string}   symbol
   * @param {string}   expiry
   * @param {string}   barSize  '5 secs'|'10 secs'|'30 secs'（IB 格式）
   * @param {Function} callback (barData) => void
   */
  subscribeRealTimeBars(symbol, expiry, barSize = "5 secs", callback) {
    const reqId = this._nextReqId();
    const contract = buildContract(symbol, expiry);
    this._subscriptions.set(reqId, { symbol, callback });
    this._ib.reqRealTimeBars(reqId, contract, 5, "TRADES", true, []);
    this._log("info", `訂閱即時 K 棒: ${symbol} reqId=${reqId}`);
    return reqId;
  }

  unsubscribe(reqId) {
    const sub = this._subscriptions.get(reqId);
    if (!sub) {
      return;
    }
    try {
      this._ib.cancelMktData(reqId);
      this._ib.cancelRealTimeBars(reqId);
    } catch {}
    this._subscriptions.delete(reqId);
  }

  // ── 歷史資料 ──────────────────────────────────────────────────
  /**
   * 取得歷史 K 棒
   * @param {string} symbol
   * @param {string} expiry
   * @param {string} duration    '1 D'|'1 W'|'1 M'|'6 M'|'1 Y'（IB 格式）
   * @param {string} barSize     '1 min'|'5 mins'|'1 hour'|'1 day'
   * @returns {Promise<object[]>} OHLCV 陣列
   */
  async getHistoricalBars(symbol, expiry, duration = "1 M", barSize = "1 day") {
    return new Promise((resolve, reject) => {
      const reqId = this._nextReqId();
      const contract = buildContract(symbol, expiry);
      this._subscriptions.set(reqId, { symbol, bars: [], resolve, reject });
      this._ib.reqHistoricalData(
        reqId,
        contract,
        "", // endDateTime（空=到現在）
        duration,
        barSize,
        "TRADES",
        1, // useRTH（只用正規交易時間）
        2, // formatDate（2=Unix timestamp）
        false,
        [],
      );

      // Timeout 30 秒
      setTimeout(() => {
        const sub = this._subscriptions.get(reqId);
        if (sub) {
          this._subscriptions.delete(reqId);
          resolve(sub.bars ?? []);
        }
      }, 30000);
    });
  }

  // ── 下單 ──────────────────────────────────────────────────────
  /**
   * 市價下單
   * @param {object} signal  { instrument, direction, qty, strategy }
   * @param {string} expiry
   * @returns {Promise<object>}  成交結果
   */
  async marketOrder(signal, expiry) {
    return this._placeOrder(signal, expiry, { orderType: OrderType?.MKT ?? "MKT" });
  }

  /**
   * 限價下單
   */
  async limitOrder(signal, expiry, limitPrice) {
    return this._placeOrder(signal, expiry, {
      orderType: OrderType?.LMT ?? "LMT",
      lmtPrice: limitPrice,
    });
  }

  /**
   * 停損市價
   */
  async stopOrder(signal, expiry, stopPrice) {
    return this._placeOrder(signal, expiry, {
      orderType: OrderType?.STP ?? "STP",
      auxPrice: stopPrice,
    });
  }

  async _placeOrder(signal, expiry, orderOpts) {
    if (!this._connected) {
      throw new Error("IB TWS 未連線");
    }

    const orderId = this._orderIdNext++;
    const contract = buildContract(signal.instrument, expiry);
    const action = ["buy", "close_short"].includes(signal.direction)
      ? (OrderAction?.BUY ?? "BUY")
      : (OrderAction?.SELL ?? "SELL");

    const order = {
      action,
      totalQuantity: signal.qty ?? 1,
      ...orderOpts,
      transmit: true,
    };

    this._log(
      "info",
      `下單 ${action} ${signal.instrument} qty=${signal.qty} ${JSON.stringify(orderOpts)}`,
    );

    return new Promise((resolve, reject) => {
      this._pendingOrders.set(orderId, { signal, resolve, reject });
      this._ib.placeOrder(orderId, contract, order);

      // Timeout 60 秒
      setTimeout(() => {
        if (this._pendingOrders.has(orderId)) {
          this._pendingOrders.delete(orderId);
          reject(new Error(`下單超時 orderId=${orderId}`));
        }
      }, 60000);
    });
  }

  /**
   * 取消訂單
   */
  cancelOrder(orderId) {
    this._ib?.cancelOrder(orderId, "");
    this._pendingOrders.delete(orderId);
  }

  // ── 帳戶查詢 ──────────────────────────────────────────────────
  getAccount() {
    return this._account;
  }
  getPositions() {
    return Object.fromEntries(this._positions);
  }
  isConnected() {
    return this._connected;
  }

  /** 取得淨資產（USD） */
  getNetLiquidation() {
    return Number.parseFloat(this._account.NetLiquidation?.value) || 0;
  }

  // ── 內部工具 ──────────────────────────────────────────────────
  _nextReqId() {
    return this._reqId++;
  }

  _log(level, msg) {
    const prefix = `[IbAdapter]`;
    if (this.logger) {
      this.logger[level]?.(`${prefix} ${msg}`);
    } else {
      const col =
        { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", debug: "\x1b[90m" }[level] ?? "";
      console.log(`${col}${prefix} ${msg}\x1b[0m`);
    }
  }

  status() {
    return {
      connected: this._connected,
      host: `${this.host}:${this.port}`,
      clientId: this.clientId,
      paper: this.paper,
      subscriptions: this._subscriptions.size,
      pendingOrders: this._pendingOrders.size,
      account: this._account,
    };
  }
}

// ── IB OrderRouter（整合進現有 OrderRouter 體系）────────────────
/**
 * 替換或擴充 OrderRouter.routeSignal()，讓海外期貨訊號走 IB
 */
export class IbOrderRouter {
  /**
   * @param {IbAdapter} adapter
   * @param {object}    expiryMap   { ES: '20250620', NQ: '20250620', ... }
   * @param {boolean}   dryRun
   */
  constructor(adapter, expiryMap = {}, dryRun = true) {
    this.adapter = adapter;
    this.expiryMap = expiryMap;
    this.dryRun = dryRun;
  }

  async routeSignal(signal) {
    const { instrument, direction, qty } = signal;
    const expiry = this.expiryMap[instrument] ?? "";

    if (this.dryRun) {
      console.log(
        `[IbOrderRouter DRY] ${direction?.toUpperCase()} ${instrument} qty=${qty} expiry=${expiry}`,
      );
      return { dryRun: true, instrument, direction, qty };
    }

    try {
      const result = await this.adapter.marketOrder(signal, expiry);
      console.log(
        `[IbOrderRouter] 成交 ${instrument} ${direction} qty=${result.filled} @${result.avgFillPrice}`,
      );
      return result;
    } catch (e) {
      console.error(`[IbOrderRouter] 下單失敗: ${e.message}`);
      throw e;
    }
  }
}
