// LogManager.mjs — 持久化日誌系統（Log Rotation + 結構化 JSON）
// 解決問題：目前所有訊息只有 console.log，重啟後全部遺失
//
// 功能：
//   多等級 (debug/info/warn/error/trade/signal)
//   每日 rotation（自動切換檔名）
//   最多保留 N 天
//   結構化 JSON Lines 格式（可用 jq 查詢）
//   同時輸出到 console（帶顏色）

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
  readFileSync,
} from "node:fs";
import path from "node:path";

const COLORS = {
  debug: "\x1b[90m", // 灰
  info: "\x1b[36m", // 青
  warn: "\x1b[33m", // 黃
  error: "\x1b[31m", // 紅
  trade: "\x1b[32m", // 綠
  signal: "\x1b[35m", // 紫
  reset: "\x1b[0m",
};

export class LogManager {
  /**
   * @param {object} opts
   * @param {string}  opts.logDir      日誌目錄（預設 ./logs）
   * @param {string}  opts.prefix      檔名前綴（預設 'openclaw'）
   * @param {number}  opts.keepDays    保留天數（預設 30）
   * @param {string}  opts.minLevel    最低等級 debug<info<warn<error（預設 'info'）
   * @param {boolean} opts.console     是否同時輸出 console（預設 true）
   * @param {boolean} opts.json        是否輸出 JSON Lines（預設 true）
   */
  constructor(opts = {}) {
    this.logDir = opts.logDir ?? path.join(process.cwd(), "logs");
    this.prefix = opts.prefix ?? "openclaw";
    this.keepDays = opts.keepDays ?? 30;
    this.minLevel = opts.minLevel ?? "info";
    this.toConsole = opts.console ?? true;
    this.toJson = opts.json ?? true;

    this._levels = ["debug", "info", "warn", "error", "trade", "signal"];
    this._minIdx = this._levels.indexOf(this.minLevel);
    this._today = "";
    this._filePath = "";

    if (this.toJson) {
      mkdirSync(this.logDir, { recursive: true });
      this._rotate();
    }
  }

  // ── 日誌方法 ──────────────────────────────────────────────────
  debug(msg, meta = {}) {
    this._log("debug", msg, meta);
  }
  info(msg, meta = {}) {
    this._log("info", msg, meta);
  }
  warn(msg, meta = {}) {
    this._log("warn", msg, meta);
  }
  error(msg, meta = {}) {
    this._log("error", msg, meta);
  }
  trade(msg, meta = {}) {
    this._log("trade", msg, meta);
  }
  signal(msg, meta = {}) {
    this._log("signal", msg, meta);
  }

  /** 記錄成交事件（結構化） */
  logFill(fill) {
    this.trade(
      `成交 ${fill.direction} ${fill.instrument} qty=${fill.qty} @${fill.fillPrice?.toFixed?.(1)}`,
      {
        type: "fill",
        ...fill,
      },
    );
  }

  /** 記錄訊號事件 */
  logSignal(sig) {
    this.signal(`訊號 ${sig.strategy} ${sig.direction} ${sig.instrument} qty=${sig.qty}`, {
      type: "signal",
      ...sig,
    });
  }

  /** 記錄風控事件 */
  logRisk(action, reason, meta = {}) {
    this.warn(`風控 [${action}] ${reason}`, { type: "risk", action, reason, ...meta });
  }

  // ── 查詢工具（讀取 JSONL 日誌）───────────────────────────────
  /**
   * 取得今日日誌的最後 N 行
   */
  tail(n = 100, level = null) {
    if (!existsSync(this._filePath)) {
      return [];
    }
    try {
      const lines = readFileSync(this._filePath, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const filtered = level ? lines.filter((l) => l.level === level) : lines;
      return filtered.slice(-n);
    } catch {
      return [];
    }
  }

  // ── 內部 ─────────────────────────────────────────────────────
  _log(level, msg, meta = {}) {
    const lvlIdx = this._levels.indexOf(level);
    if (lvlIdx < this._minIdx) {
      return;
    }

    const ts = new Date().toISOString();
    const entry = { ts, level, msg, ...meta };

    // Console 輸出（帶顏色）
    if (this.toConsole) {
      const col = COLORS[level] ?? "";
      const reset = COLORS.reset;
      const tag = `[${level.toUpperCase().padEnd(6)}]`;
      const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
      console.log(`${col}${ts.slice(11, 23)} ${tag} ${msg}${metaStr}${reset}`);
    }

    // JSON Lines 輸出
    if (this.toJson) {
      this._rotate();
      try {
        appendFileSync(this._filePath, JSON.stringify(entry) + "\n");
      } catch {}
    }
  }

  _rotate() {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this._today) {
      return;
    }
    this._today = today;
    this._filePath = path.join(this.logDir, `${this.prefix}-${today}.jsonl`);
    this._cleanup();
  }

  _cleanup() {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.startsWith(this.prefix) && f.endsWith(".jsonl"))
        .map((f) => ({ name: f, time: statSync(path.join(this.logDir, f)).mtimeMs }))
        .toSorted((a, b) => b.time - a.time);

      for (const f of files.slice(this.keepDays)) {
        unlinkSync(path.join(this.logDir, f.name));
      }
    } catch {}
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────
let _instance = null;
export function getLogger(opts = {}) {
  if (!_instance) {
    _instance = new LogManager(opts);
  }
  return _instance;
}
export function initLogger(opts = {}) {
  _instance = new LogManager(opts);
  return _instance;
}
