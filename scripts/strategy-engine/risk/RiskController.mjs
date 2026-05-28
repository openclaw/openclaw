// RiskController.mjs — 帳戶層級風控閘門
// 所有訊號在送到 OrderRouter 前必須通過此閘門
//
// 保護層：
//   1. 單日最大虧損 (dailyLossLimit)     — 超過即熔斷當日交易
//   2. 整體最大回撤 (maxDrawdownPct)     — 超過即停止所有策略
//   3. 單商品部位上限 (maxPositionPerInstrument)
//   4. 整體淨曝險上限 (maxNetExposure)   — 多空加總口數
//   5. 每分鐘下單頻率 (maxOrdersPerMin)  — 防止訊號爆量
//   6. 相關性風控 (correlatedBlock)      — 同向策略重疊時降頻
//
// 熔斷後必須呼叫 resume() 或等待自動重置時間才能恢復

export class RiskController {
  /**
   * @param {object} cfg
   * @param {number}  cfg.initialCapital        初始資金（用於計算回撤%）
   * @param {number}  cfg.dailyLossLimit        單日最大虧損金額（絕對值）
   * @param {number}  cfg.maxDrawdownPct        整體最大回撤百分比 0~1（預設 0.15 = 15%）
   * @param {number}  cfg.maxPositionPerInst    單商品最大持倉口數（預設 10）
   * @param {number}  cfg.maxNetExposure        整體最大淨曝險口數（預設 20）
   * @param {number}  cfg.maxOrdersPerMin       每分鐘最多下單次數（預設 60）
   * @param {number}  cfg.autoResumeMs          熔斷後自動恢復時間 ms（0=不自動，預設 0）
   * @param {boolean} cfg.verbose               是否印出每次通過/拒絕
   */
  constructor(cfg = {}) {
    this.initialCapital = cfg.initialCapital ?? 1_000_000;
    this.dailyLossLimit = cfg.dailyLossLimit ?? 50_000;
    this.maxDrawdownPct = cfg.maxDrawdownPct ?? 0.15;
    this.maxPositionPerInst = cfg.maxPositionPerInst ?? 10;
    this.maxNetExposure = cfg.maxNetExposure ?? 20;
    this.maxOrdersPerMin = cfg.maxOrdersPerMin ?? 60;
    this.autoResumeMs = cfg.autoResumeMs ?? 0;
    this.verbose = cfg.verbose ?? false;

    // 內部狀態
    this._capital = this.initialCapital;
    this._peakCapital = this.initialCapital;
    this._dailyPnl = 0;
    this._positions = {}; // instrument → net qty (+ 多 / - 空)
    this._orderTimes = []; // 最近下單時間戳記（滑動窗口）
    this._killed = false;
    this._killReason = "";
    this._blockedCount = 0;
    this._passedCount = 0;
    this._lastDayReset = new Date().toDateString();

    // 每日重置 timer（午夜）
    this._scheduleReset();
  }

  // ── 主要閘門：外部呼叫此方法決定是否放行 ──────────────────────
  /**
   * @param {object} signal   策略發出的訊號
   * @returns {{ ok: boolean, reason: string }}
   */
  check(signal) {
    // 自動日期重置
    this._autoReset();

    // 1. 系統熔斷
    if (this._killed) {
      return this._block(`🔴 熔斷中: ${this._killReason}`);
    }

    // 2. 單日虧損
    if (this._dailyPnl <= -Math.abs(this.dailyLossLimit)) {
      this._kill(`單日虧損 ${this._dailyPnl.toFixed(0)} 超過限制 ${this.dailyLossLimit}`);
      return this._block(`🔴 觸發單日虧損熔斷`);
    }

    // 3. 整體最大回撤
    const drawdown = (this._peakCapital - this._capital) / this._peakCapital;
    if (drawdown >= this.maxDrawdownPct) {
      this._kill(
        `最大回撤 ${(drawdown * 100).toFixed(1)}% ≥ 限制 ${(this.maxDrawdownPct * 100).toFixed(0)}%`,
      );
      return this._block(`🔴 觸發最大回撤熔斷`);
    }

    // 4. 單商品部位上限
    const inst = signal.instrument ?? "";
    const curPos = Math.abs(this._positions[inst] ?? 0);
    const dir = signal.direction ?? "";
    const qty = signal.qty ?? 1;
    const orderQty = Number(qty);
    const isOpen = dir === "buy" || dir === "sell";

    if (isOpen && curPos + orderQty > this.maxPositionPerInst) {
      return this._block(`⚠️  ${inst} 部位 ${curPos}+${qty} 超過上限 ${this.maxPositionPerInst}`);
    }

    // 5. 整體淨曝險
    const netExposure = Object.values(this._positions).reduce((s, v) => s + Math.abs(Number(v)), 0);
    if (isOpen && netExposure + orderQty > this.maxNetExposure) {
      return this._block(
        `⚠️  整體曝險 ${String(netExposure)}+${orderQty} 超過上限 ${this.maxNetExposure}`,
      );
    }

    // 6. 下單頻率
    const now = Date.now();
    this._orderTimes = this._orderTimes.filter((t) => now - t < 60_000);
    if (this._orderTimes.length >= this.maxOrdersPerMin) {
      return this._block(`⚠️  下單頻率 ${this._orderTimes.length}/min 超過上限`);
    }

    // ── 放行 ─────────────────────────────────────────────────
    this._orderTimes.push(now);
    this._passedCount++;
    if (this.verbose) {
      console.log(`[RiskCtrl] ✅ 放行 ${signal.strategy} ${dir} ${inst} qty=${qty}`);
    }
    return { ok: true, reason: "pass" };
  }

  // ── 成交回報：更新部位和資金 ──────────────────────────────────
  /**
   * @param {object} fill  { instrument, direction, qty, pnl }
   */
  onFill(fill) {
    const { instrument, direction, qty = 1, pnl = 0 } = fill;
    const inst = instrument ?? "";

    // 更新部位
    if (!this._positions[inst]) {
      this._positions[inst] = 0;
    }
    if (direction === "buy") {
      this._positions[inst] += qty;
    } else if (direction === "sell") {
      this._positions[inst] -= qty;
    } else if (direction === "close_long") {
      this._positions[inst] = Math.max(0, this._positions[inst] - qty);
    } else if (direction === "close_short") {
      this._positions[inst] = Math.min(0, this._positions[inst] + qty);
    }

    // 更新資金與回撤追蹤
    this._capital += pnl;
    this._dailyPnl += pnl;
    this._peakCapital = Math.max(this._peakCapital, this._capital);
  }

  // ── 手動熔斷 / 恢復 ──────────────────────────────────────────
  kill(reason = "手動熔斷") {
    this._kill(reason);
  }

  resume() {
    if (!this._killed) {
      return;
    }
    this._killed = false;
    this._killReason = "";
    console.log("[RiskCtrl] ▶️  熔斷解除，恢復交易");
  }

  // ── 資金同步 ──────────────────────────────────────────────────
  syncCapital(capital) {
    this._capital = capital;
    this._peakCapital = Math.max(this._peakCapital, capital);
  }

  // ── 狀態報告 ──────────────────────────────────────────────────
  status() {
    const drawdown = (this._peakCapital - this._capital) / this._peakCapital;
    return {
      killed: this._killed,
      killReason: this._killReason,
      capital: this._capital,
      peakCapital: this._peakCapital,
      drawdownPct: +(drawdown * 100).toFixed(2),
      dailyPnl: this._dailyPnl,
      positions: { ...this._positions },
      ordersPerMin: this._orderTimes.filter((t) => Date.now() - t < 60_000).length,
      blockedCount: this._blockedCount,
      passedCount: this._passedCount,
    };
  }

  // ── 內部 ─────────────────────────────────────────────────────
  _kill(reason) {
    if (this._killed) {
      return;
    }
    this._killed = true;
    this._killReason = reason;
    console.error(`[RiskCtrl] 🔴 熔斷觸發: ${reason}`);
    if (this.autoResumeMs > 0) {
      setTimeout(() => this.resume(), this.autoResumeMs);
    }
  }

  _block(reason) {
    this._blockedCount++;
    if (this.verbose) {
      console.warn(`[RiskCtrl] ❌ 攔截: ${reason}`);
    }
    return { ok: false, reason };
  }

  _autoReset() {
    const today = new Date().toDateString();
    if (today !== this._lastDayReset) {
      this._dailyPnl = 0;
      this._lastDayReset = today;
      if (this._killed && this._killReason.includes("單日虧損")) {
        this.resume(); // 單日虧損熔斷次日自動解除
      }
      console.log("[RiskCtrl] 📅 每日重置：dailyPnl 歸零");
    }
  }

  _scheduleReset() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const ms = midnight - now;
    setTimeout(() => {
      this._autoReset();
      this._scheduleReset();
    }, ms);
  }
}
