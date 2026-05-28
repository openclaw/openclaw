// TwapVwapExecutor.mjs — TWAP / VWAP 智能拆單執行算法
// 移植自 ITG / Liquidnet 執行算法 / QuantLib TWAP
// 開源參考：https://github.com/QuantConnect/Lean/blob/master/Algorithm/Execution
//
// TWAP：將大單均分成 N 份，每份間隔 intervalMs 執行
// VWAP：依歷史成交量分佈加權，量大時多送，量小時少送
// 防止市場衝擊（Market Impact），適合大單進出場
export class TwapVwapExecutor {
  constructor(config) {
    this.name = config.name;
    this.instrument = config.instrument;
    this.broker = config.broker;
    this.params = config.params ?? {};
    this.autoExecute = config.auto ?? true; // 執行算法預設自動

    this.mode = this.params.mode ?? "twap"; // 'twap' | 'vwap'
    this.totalQty = this.params.totalQty ?? 10; // 總目標口數
    this.slices = this.params.slices ?? 10; // 拆分份數
    this.intervalMs = this.params.intervalMs ?? 30000; // 每份間隔
    this.direction = this.params.direction ?? "buy"; // 'buy' | 'sell'
    this.maxSlippage = this.params.maxSlippage ?? 0.001; // 最大允許滑點 0.1%

    // 歷史成交量分佈（按小時）用於 VWAP 加權
    // 預設均勻分佈，實際可從歷史數據載入
    this._volumeProfile = this.params.volumeProfile ?? Array(24).fill(1 / 24);

    this._executed = 0; // 已執行口數
    this._sliceDone = 0; // 已執行份數
    this._startTime = null;
    this._lastSliceAt = 0;
    this._signals = [];
    this._active = false;
    this._enabled = true;
  }

  /** 開始執行 */
  start(totalQty, direction) {
    if (totalQty) {
      this.totalQty = totalQty;
    }
    if (direction) {
      this.direction = direction;
    }
    this._executed = 0;
    this._sliceDone = 0;
    this._startTime = Date.now();
    this._lastSliceAt = 0;
    this._active = true;
    console.log(
      `[TWAP/VWAP] ${this.name} 開始執行: ${this.direction} ${this.totalQty}口 × ${this.slices}份 模式=${this.mode}`,
    );
  }

  /** 每 tick 或定時調用 */
  onTick(tick, analyzer) {
    if (!this._active) {
      return;
    }
    const now = Date.now();
    if (now - this._lastSliceAt < this.intervalMs) {
      return;
    }
    if (this._executed >= this.totalQty) {
      this._active = false;
      return;
    }

    // 計算本次執行量
    let sliceQty = Math.ceil(this.totalQty / this.slices);
    if (this.mode === "vwap") {
      const hour = new Date().getHours();
      const weight = this._volumeProfile[hour] * 24; // 相對均值的比例
      sliceQty = Math.max(1, Math.round(sliceQty * weight));
    }
    sliceQty = Math.min(sliceQty, this.totalQty - this._executed);
    if (sliceQty <= 0) {
      this._active = false;
      return;
    }

    // 滑點檢查
    const price = tick?.price ?? analyzer?.midPrice?.() ?? 0;
    if (analyzer && price > 0) {
      const impact = analyzer.marketImpact(this.direction, sliceQty);
      if (impact.slippage / price > this.maxSlippage) {
        console.log(
          `[TWAP/VWAP] 滑點 ${((impact.slippage / price) * 100).toFixed(3)}% 超限，延遲執行`,
        );
        return;
      }
    }

    this._signals.push({
      time: new Date().toISOString(),
      strategy: this.name,
      instrument: this.instrument,
      broker: this.broker,
      direction: this.direction,
      qty: sliceQty,
      price,
      reason: `${this.mode.toUpperCase()} 第${this._sliceDone + 1}/${this.slices}份 累計=${this._executed + sliceQty}/${this.totalQty}口`,
      autoExecute: this.autoExecute,
      executionType: this.mode,
    });

    this._executed += sliceQty;
    this._sliceDone++;
    this._lastSliceAt = now;

    if (this._executed >= this.totalQty) {
      this._active = false;
      console.log(`[TWAP/VWAP] ${this.name} 執行完成: 共 ${this._executed} 口`);
    }
  }

  get isActive() {
    return this._active;
  }
  get progress() {
    return this.totalQty > 0 ? this._executed / this.totalQty : 0;
  }
  popSignals() {
    const s = [...this._signals];
    this._signals = [];
    return s;
  }
  get enabled() {
    return this._enabled;
  }
}
