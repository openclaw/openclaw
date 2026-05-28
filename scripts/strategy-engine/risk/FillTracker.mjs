// FillTracker.mjs — 成交回報迴路
// 橋接 OrderRouter（下單）↔ Strategy（成交後更新）↔ PositionSizer（更新績效）
//
// 解決問題：
//   OrderRouter 寫出 JSON 命令後無回報
//   策略不知道是否成交，可能重複下單
//   PositionSizer 的 Kelly 統計無法自動更新
//
// 運作方式：
//   1. OrderRouter 填寫假設成交（dryRun）或輪詢成交檔案（live）
//   2. FillTracker 接收成交事件並廣播給：
//      a. 相關策略 (strategy.onFill)
//      b. RiskController (onFill)
//      c. PositionSizer (recordTrade)
//      d. Dashboard (pushPosition)
//      e. NotifyManager (signal)
//   3. 維護全域部位帳本 (PositionBook)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── 部位帳本 ──────────────────────────────────────────────────────
export class PositionBook {
  constructor() {
    this._positions = new Map();
    // instrument → { qty, avgPrice, realizedPnl, unrealizedPnl, trades[] }
  }

  apply(fill) {
    const { instrument, direction, qty = 1, fillPrice = 0, pnl = 0 } = fill;
    if (!this._positions.has(instrument)) {
      this._positions.set(instrument, {
        qty: 0,
        avgPrice: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        trades: [],
      });
    }
    const pos = this._positions.get(instrument);

    if (direction === "buy") {
      // 加多倉：更新均價
      const newQty = pos.qty + qty;
      pos.avgPrice = newQty > 0 ? (pos.avgPrice * pos.qty + fillPrice * qty) / newQty : fillPrice;
      pos.qty = newQty;
    } else if (direction === "sell") {
      // 加空倉 or 平多
      if (pos.qty > 0) {
        // 平多倉
        const closedQty = Math.min(qty, pos.qty);
        pos.realizedPnl += (fillPrice - pos.avgPrice) * closedQty;
        pos.qty -= closedQty;
        if (pos.qty === 0) {
          pos.avgPrice = 0;
        }
        // 若有餘量則開空
        const rem = qty - closedQty;
        if (rem > 0) {
          pos.qty = -rem;
          pos.avgPrice = fillPrice;
        }
      } else {
        const newQty = pos.qty - qty;
        pos.avgPrice =
          newQty < 0
            ? (pos.avgPrice * Math.abs(pos.qty) + fillPrice * qty) / Math.abs(newQty)
            : fillPrice;
        pos.qty = newQty;
      }
    } else if (direction === "close_long" && pos.qty > 0) {
      const closedQty = Math.min(qty, pos.qty);
      pos.realizedPnl += (fillPrice - pos.avgPrice) * closedQty;
      pos.qty -= closedQty;
      if (pos.qty === 0) {
        pos.avgPrice = 0;
      }
    } else if (direction === "close_short" && pos.qty < 0) {
      const closedQty = Math.min(qty, Math.abs(pos.qty));
      pos.realizedPnl += (pos.avgPrice - fillPrice) * closedQty;
      pos.qty += closedQty;
      if (pos.qty === 0) {
        pos.avgPrice = 0;
      }
    }

    pos.realizedPnl += pnl; // 外部提供的確認 PnL
    pos.trades.push({ ...fill, ts: new Date().toISOString() });
    if (pos.trades.length > 200) {
      pos.trades.shift();
    }
    return pos;
  }

  updateUnrealized(instrument, currentPrice) {
    const pos = this._positions.get(instrument);
    if (!pos || pos.qty === 0) {
      return;
    }
    pos.unrealizedPnl = (currentPrice - pos.avgPrice) * pos.qty;
  }

  get(instrument) {
    return this._positions.get(instrument) ?? null;
  }
  getAll() {
    return Object.fromEntries(this._positions);
  }

  totalRealizedPnl() {
    return [...this._positions.values()].reduce((s, p) => s + p.realizedPnl, 0);
  }
  totalUnrealizedPnl() {
    return [...this._positions.values()].reduce((s, p) => s + p.unrealizedPnl, 0);
  }
}

// ── FillTracker 主類別 ─────────────────────────────────────────────
export class FillTracker {
  /**
   * @param {object} opts
   * @param {boolean} opts.dryRun          dryRun 模式下模擬立即成交
   * @param {string}  opts.fillFilePath    Live 模式：輪詢成交回報 JSON 檔路徑
   * @param {number}  opts.pollMs          輪詢間隔（預設 500ms）
   * @param {object}  opts.riskController  RiskController 實例（可選）
   * @param {object}  opts.positionSizer   PositionSizer 實例（可選）
   * @param {object}  opts.dashboard       DashboardServer 實例（可選）
   * @param {object}  opts.notifier        NotifyManager 實例（可選）
   */
  constructor(opts = {}) {
    this.dryRun = opts.dryRun ?? true;
    this.fillFilePath = opts.fillFilePath ?? null;
    this.pollMs = opts.pollMs ?? 500;
    this.riskController = opts.riskController ?? null;
    this.positionSizer = opts.positionSizer ?? null;
    this.dashboard = opts.dashboard ?? null;
    this.notifier = opts.notifier ?? null;

    this.book = new PositionBook();
    this._strategies = new Map(); // name → strategy instance
    this._pendingOrders = new Map(); // orderId → { signal, strategy, ts }
    this._processedIds = new Set(); // 防止重複處理
    this._running = false;
    this._fillCount = 0;
  }

  // ── 策略註冊 ──────────────────────────────────────────────────
  registerStrategy(strategy) {
    this._strategies.set(strategy.name, strategy);
  }

  // ── DryRun：訊號發出後立即模擬成交 ───────────────────────────
  /**
   * 由 StrategyEngine 在訊號放行後呼叫
   * @param {object} signal  通過 RiskController 的訊號
   * @param {number} fillPrice  成交價（dryRun 用收盤價）
   */
  simulateFill(signal, fillPrice) {
    const fill = {
      orderId: `dry_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      instrument: signal.instrument,
      direction: signal.direction,
      qty: signal.qty ?? 1,
      fillPrice: fillPrice ?? signal.price ?? 0,
      pnl: 0, // dryRun 沒有真實 PnL，由 Backtester 計算
      strategy: signal.strategy,
      ts: new Date().toISOString(),
      dryRun: true,
    };
    this._processFill(fill);
    return fill;
  }

  // ── Live 模式：輪詢成交檔案 ───────────────────────────────────
  start() {
    if (this.dryRun || !this.fillFilePath) {
      return;
    }
    this._running = true;
    void this._pollLoop();
    console.log(`[FillTracker] 啟動輪詢 ${this.fillFilePath} 每 ${this.pollMs}ms`);
  }

  stop() {
    this._running = false;
  }

  async _pollLoop() {
    while (this._running) {
      this._pollFillFile();
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  _pollFillFile() {
    if (!existsSync(this.fillFilePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.fillFilePath, "utf-8");
      const fills = JSON.parse(raw);
      if (!Array.isArray(fills)) {
        return;
      }

      for (const fill of fills) {
        if (!fill.orderId || this._processedIds.has(fill.orderId)) {
          continue;
        }
        this._processedIds.add(fill.orderId);
        this._processFill(fill);
      }

      // 清空已處理的成交（保留最新 50 筆未處理）
      const unprocessed = fills.filter((f) => !this._processedIds.has(f.orderId));
      writeFileSync(this.fillFilePath, JSON.stringify(unprocessed, null, 2));
    } catch {}
  }

  // ── 核心：廣播成交給所有下游 ─────────────────────────────────
  _processFill(fill) {
    this._fillCount++;

    // 1. 更新部位帳本
    const pos = this.book.apply(fill);

    // 2. 通知策略
    const strat = this._strategies.get(fill.strategy);
    if (strat?.onFill) {
      try {
        strat.onFill(fill);
      } catch {}
    }

    // 3. 通知 RiskController
    if (this.riskController) {
      this.riskController.onFill(fill);
    }

    // 4. 更新 PositionSizer（Kelly 統計）
    if (this.positionSizer && fill.pnl != null && fill.pnl !== 0) {
      this.positionSizer.recordTrade(fill.pnl);
    }

    // 5. 推送 Dashboard
    if (this.dashboard && pos) {
      this.dashboard.pushPosition(fill.instrument, pos.qty, pos.avgPrice, pos.unrealizedPnl);
      // 同時推送成交記錄（v2 新增）
      if (typeof this.dashboard.pushFill === "function") {
        this.dashboard.pushFill(fill);
      }
    }

    // 6. 通知系統
    if (this.notifier && fill.pnl) {
      const icon = fill.pnl > 0 ? "💰" : "💸";
      this.notifier
        .signal({
          direction: "fill",
          instrument: fill.instrument,
          strategy: fill.strategy,
          reason: `${icon} 成交 ${fill.direction} ${fill.qty}口 @${fill.fillPrice?.toFixed(1)} PnL=${fill.pnl?.toFixed(0)}`,
          qty: fill.qty,
        })
        .catch(() => {});
    }

    console.log(
      `[FillTracker] #${this._fillCount} ${fill.strategy} ${fill.direction} ` +
        `${fill.instrument} qty=${fill.qty} @${fill.fillPrice?.toFixed?.(1) ?? fill.fillPrice}` +
        (fill.pnl ? ` PnL=${fill.pnl >= 0 ? "+" : ""}${fill.pnl?.toFixed?.(0)}` : ""),
    );
  }

  // ── 狀態 ─────────────────────────────────────────────────────
  getPositions() {
    return this.book.getAll();
  }
  getTotalPnl() {
    return this.book.totalRealizedPnl() + this.book.totalUnrealizedPnl();
  }
  getFillCount() {
    return this._fillCount;
  }
}
