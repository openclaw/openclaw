// ConfigWatcher.mjs — 策略設定熱重載
// 解決問題：調整策略參數必須重啟整個引擎，中斷所有連線
//
// 功能：
//   1. 監聽 config JSON 檔案變動（fs.watch）
//   2. Debounce 300ms 避免快速連續觸發
//   3. Diff 比較：新增/移除/修改的策略
//   4. 呼叫 engine.hotReload() 動態更新
//   5. 廣播 hot_reload 事件到 Dashboard

import { readFileSync, watch } from "node:fs";
import path from "node:path";

export class ConfigWatcher {
  /**
   * @param {string}   configPath   監聽的 JSON 設定檔路徑
   * @param {object}   engine       StrategyEngine 實例
   * @param {object}   opts
   * @param {number}   opts.debounceMs  防抖延遲（預設 300ms）
   * @param {Function} opts.onReload    reload 完成後的 callback(diff)
   * @param {object}   opts.logger      LogManager 實例（可選）
   */
  constructor(configPath, engine, opts = {}) {
    this.configPath = configPath;
    this.engine = engine;
    this.debounceMs = opts.debounceMs ?? 300;
    this.onReload = opts.onReload ?? null;
    this.logger = opts.logger ?? null;

    this._watcher = null;
    this._timer = null;
    this._lastConfig = null;
    this._reloadCount = 0;
  }

  start() {
    // 讀入初始設定
    try {
      this._lastConfig = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      this._log("error", `ConfigWatcher 無法讀取初始設定: ${e.message}`);
      return;
    }

    this._watcher = watch(this.configPath, { persistent: false }, (event) => {
      if (event !== "change") {
        return;
      }
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._doReload(), this.debounceMs);
    });

    this._log("info", `ConfigWatcher 啟動，監聽: ${path.basename(this.configPath)}`);
  }

  stop() {
    this._watcher?.close();
    clearTimeout(this._timer);
    this._log("info", "ConfigWatcher 已停止");
  }

  /** 手動觸發 reload（API 端點用） */
  async forceReload() {
    return this._doReload();
  }

  async _doReload() {
    let newConfig;
    try {
      newConfig = JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch (e) {
      this._log("error", `ConfigWatcher 解析失敗: ${e.message}`);
      return null;
    }

    const diff = this._diff(this._lastConfig, newConfig);
    if (!diff.hasChanges) {
      this._log("debug", "ConfigWatcher: 設定無變動");
      return null;
    }

    this._reloadCount++;
    this._log("info", `ConfigWatcher #${this._reloadCount} 偵測到變動 → 熱重載`);

    try {
      await this.engine.hotReload(newConfig, diff);
      this._lastConfig = newConfig;
      this.onReload?.(diff);
      return diff;
    } catch (e) {
      this._log("error", `ConfigWatcher 熱重載失敗: ${e.message}`);
      return null;
    }
  }

  // ── Diff 計算 ─────────────────────────────────────────────────
  _diff(oldConfig, newConfig) {
    const oldStrats = new Map((oldConfig?.strategies ?? []).map((s) => [s.name, s]));
    const newStrats = new Map((newConfig?.strategies ?? []).map((s) => [s.name, s]));

    const added = [];
    const removed = [];
    const updated = [];
    const unchanged = [];

    // 新增或修改
    for (const [name, newS] of newStrats) {
      if (!oldStrats.has(name)) {
        added.push(newS);
      } else {
        const oldS = oldStrats.get(name);
        const changed = JSON.stringify(oldS) !== JSON.stringify(newS);
        if (changed) {
          updated.push({ old: oldS, new: newS });
        } else {
          unchanged.push(name);
        }
      }
    }

    // 移除
    for (const [name] of oldStrats) {
      if (!newStrats.has(name)) {
        removed.push(name);
      }
    }

    // 全域設定變動（capital、riskControl 等）
    const globalChanged = {};
    for (const key of [
      "capital",
      "riskControl",
      "positionSizing",
      "correlationMonitor",
      "pollMs",
    ]) {
      const ov = JSON.stringify(oldConfig?.[key]);
      const nv = JSON.stringify(newConfig?.[key]);
      if (ov !== nv) {
        globalChanged[key] = { old: oldConfig?.[key], new: newConfig?.[key] };
      }
    }

    const hasChanges =
      added.length > 0 ||
      removed.length > 0 ||
      updated.length > 0 ||
      Object.keys(globalChanged).length > 0;

    return {
      added,
      removed,
      updated,
      unchanged,
      globalChanged,
      hasChanges,
      ts: new Date().toISOString(),
    };
  }

  _log(level, msg) {
    if (this.logger) {
      this.logger[level]?.(msg);
    } else {
      const prefix =
        { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", debug: "\x1b[90m" }[level] ?? "";
      console.log(`${prefix}[ConfigWatcher] ${msg}\x1b[0m`);
    }
  }

  status() {
    return {
      watching: !!this._watcher,
      configPath: this.configPath,
      reloadCount: this._reloadCount,
    };
  }
}
