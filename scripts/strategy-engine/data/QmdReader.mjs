/**
 * QmdReader.mjs
 * 解析群益 MultiCharts QMD 二進位格式（Capital MC12 x64 歷史資料包）
 *
 * 檔案格式（逆向工程）：
 *   0x000  魔術 "QMD\0" + version=1 + header_size=1560 + symbol_count + entry_size=40
 *   0x018  Entry 目錄（38 × 40 bytes）
 *   ...
 *   Entry 1:  XML 商品目錄（iso-8859-1 + Big5 描述）
 *   Entry 2,10,18: 50MB 大型多商品 tick 塊（type=3）
 *   其餘 type=1 Entry: 單一商品 OHLCV K 棒
 *
 * 每筆 88-byte 紀錄格式（type=1 entry）：
 *   +0   int64  .NET Ticks 時間（100ns intervals since 0001-01-01 UTC）
 *   +8   float64 Open
 *   +16  float64 High
 *   +24  float64 Low
 *   +32  float64 Close
 *   +40  int64  Volume（合約數）
 *   +48  48 bytes 其他欄位（bid/ask qty 等，暫不使用）
 *
 * 主要 API：
 *   QmdReader.open(filePath)         → 建立讀取器
 *   reader.listSymbols()             → 列出可用商品
 *   reader.readBars(symbol, opts)    → 讀取 OHLCV K 棒陣列
 */
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";

// ── 常數 ──────────────────────────────────────────────────────────
const MAGIC = 0x00444d51; // "QMD\0" LE
const ENTRY_BASE = 0x18;
const RECORD_SIZE = 88;
const DOTNET_EPOCH_DIFF = 621355968000000000n; // BigInt: 100ns from 0001-01-01 → 1970-01-01

// 已確認的 symbol → entry 對應（從啟動日期 + 價格範圍反查）
// 對應檔案：群益MC12x64內期歷史資料包_20241212.qmd
const KNOWN_SYMBOL_ENTRIES = {
  TXF1: { daily: 17, minuteEntries: [3, 4, 5, 6, 7] }, // 臺指期（1998-07-22~）
  MXF1: { daily: 15, minuteEntries: [] }, // 小台指（2001-04-09~）
  FXF1: { daily: 11, minuteEntries: [] }, // 金融期（1999-07-21~）
  EXF1: { daily: 13, minuteEntries: [] }, // 電子期（1999-07-21~）
};

// ── 時間轉換 ──────────────────────────────────────────────────────
/**
 * .NET DateTime.Ticks（int64 BigInt）→ JS Date
 */
function ticksToDate(ticksBig) {
  const unixMs = Number((ticksBig - DOTNET_EPOCH_DIFF) / 10000n);
  return new Date(unixMs);
}

// ── 壓縮區塊解壓 ──────────────────────────────────────────────────
/**
 * 讀取 QMD 壓縮區塊：[unc_size 4B][comp_size 4B][zlib_data...]
 * @param {Buffer} raw     完整檔案 Buffer
 * @param {number} offset  區塊在檔案中的偏移量
 */
function readBlock(raw, offset) {
  const compSize = raw.readUInt32LE(offset + 4);
  const zlibData = raw.slice(offset + 8, offset + 8 + compSize);
  return inflateSync(zlibData);
}

// ── Entry 目錄解析 ────────────────────────────────────────────────
function parseEntryDirectory(raw) {
  const entryCount = raw.readUInt32LE(0x10);
  const entryStride = raw.readUInt32LE(0x14);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const off = ENTRY_BASE + i * entryStride;
    entries.push({
      index: i,
      fileOff: raw.readUInt32LE(off),
      type: raw.readUInt32LE(off + 4),
    });
  }
  return { entryCount, entries };
}

// ── XML 商品目錄解析 ──────────────────────────────────────────────
function parseXmlCatalog(raw, entries) {
  const xmlEntry = entries[1]; // Entry 1 = XML catalog
  if (!xmlEntry || xmlEntry.fileOff === 0) {
    return [];
  }

  const block = readBlock(raw, xmlEntry.fileOff);
  const xml = block.toString("latin1");

  const symbols = [];
  const tagRe = /<symbol([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1];
    const ga = (name) => {
      const mm = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return mm ? mm[1] : "";
    };
    const descRaw = ga("description");
    let descCh = "";
    try {
      descCh = Buffer.from(descRaw, "latin1").toString("big5");
    } catch {
      descCh = descRaw;
    }

    symbols.push({
      id: Number.parseInt(ga("id"), 10),
      name: ga("symbolName"),
      root: ga("symbolRoot"),
      desc: descCh,
      category: Number.parseInt(ga("category"), 10),
    });
  }
  return symbols;
}

// ── OHLCV 解析（type=1 entry, 88-byte records）────────────────────
/**
 * @param {Buffer} data    已解壓的 entry 資料
 * @param {Date}   [since] 過濾起始時間（含）
 * @param {Date}   [until] 過濾結束時間（含）
 * @returns {Array<{time, open, high, low, close, volume}>}
 */
function parseOhlcvBlock(data, since, until) {
  const n = Math.floor(data.length / RECORD_SIZE);
  const sinceTs = since ? since.getTime() : 0;
  const untilTs = until ? until.getTime() : Infinity;
  const bars = [];

  for (let i = 0; i < n; i++) {
    const off = i * RECORD_SIZE;
    // .NET ticks stored as int64 LE — read as BigInt
    const ticks = data.readBigInt64LE(off);
    const dt = ticksToDate(ticks);
    const ts = dt.getTime();

    if (ts < sinceTs || ts > untilTs) {
      continue;
    }

    const o = data.readDoubleLE(off + 8);
    const h = data.readDoubleLE(off + 16);
    const l = data.readDoubleLE(off + 24);
    const c = data.readDoubleLE(off + 32);
    const v = Number(data.readBigInt64LE(off + 40));

    // Sanity check: price must be positive and finite
    if (!Number.isFinite(c) || c <= 0) {
      continue;
    }

    bars.push({ time: dt.toISOString(), open: o, high: h, low: l, close: c, volume: v });
  }
  return bars;
}

// ── 主類別 ────────────────────────────────────────────────────────
export class QmdReader {
  /**
   * @param {string} filePath  .qmd 檔案路徑
   */
  constructor(filePath) {
    if (!existsSync(filePath)) {
      throw new Error(`QMD 檔案不存在: ${filePath}`);
    }
    this._raw = readFileSync(filePath);
    this._path = filePath;

    // 驗證 magic
    const magic = this._raw.readUInt32LE(0);
    if (magic !== MAGIC) {
      throw new Error(`非 QMD 格式（magic=${magic.toString(16)}）`);
    }

    const { entries } = parseEntryDirectory(this._raw);
    this._entries = entries;
    this._symbols = parseXmlCatalog(this._raw, entries);
  }

  /**
   * 靜態工廠方法
   * @param {string} filePath
   */
  static open(filePath) {
    return new QmdReader(filePath);
  }

  /**
   * 列出 XML 目錄中的商品清單
   */
  listSymbols() {
    return this._symbols.map((s) => ({
      name: s.name,
      root: s.root,
      desc: s.desc,
      category: s.category,
    }));
  }

  /**
   * 讀取 OHLCV K 棒
   * @param {string} symbol   商品代碼（TXF1 / MXF1 / FXF1 / EXF1）或 'auto' 自動偵測
   * @param {object} opts
   * @param {string}  [opts.since]    起始時間 ISO 字串（含，預設：全部）
   * @param {string}  [opts.until]    結束時間 ISO 字串（含，預設：全部）
   * @param {boolean} [opts.daily]    是否只讀日 K（預設 true）
   * @param {boolean} [opts.minute]   讀分 K（true 時 daily 自動設為 false）
   * @param {boolean} [opts.allEntries] 合併所有相關 entry（用於拼接分鐘資料，預設 false）
   * @returns {Array<{time, open, high, low, close, volume}>}
   */
  readBars(
    symbol,
    { since, until, daily: _daily = true, minute = false, allEntries = false } = {},
  ) {
    const sinceDate = since ? new Date(since) : null;
    const untilDate = until ? new Date(until) : null;

    const knownMap = KNOWN_SYMBOL_ENTRIES[symbol.toUpperCase()];
    let entryIndices = [];

    if (knownMap) {
      if (minute) {
        entryIndices = knownMap.minuteEntries ?? [];
      } else {
        // daily
        entryIndices = [knownMap.daily];
        if (allEntries && knownMap.minuteEntries?.length) {
          entryIndices = [...entryIndices, ...knownMap.minuteEntries];
        }
      }
    } else {
      // Auto-detect: scan type-1 entries by price/date fingerprint
      entryIndices = this._detectEntries(symbol);
    }

    if (!entryIndices.length) {
      throw new Error(
        `找不到商品 ${symbol} 的資料 entry，可用商品：${Object.keys(KNOWN_SYMBOL_ENTRIES).join(", ")}`,
      );
    }

    const allBars = [];
    for (const idx of entryIndices) {
      const entry = this._entries[idx];
      if (!entry || entry.fileOff === 0 || entry.type !== 1) {
        continue;
      }
      try {
        const block = readBlock(this._raw, entry.fileOff);
        const bars = parseOhlcvBlock(block, sinceDate, untilDate);
        allBars.push(...bars);
      } catch (err) {
        console.warn(`[QmdReader] entry ${idx} 解壓失敗: ${err.message}`);
      }
    }

    // 排序 + 去重（合併多 entry 時可能有重疊）
    allBars.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const unique = [];
    let lastTime = "";
    for (const bar of allBars) {
      if (bar.time !== lastTime) {
        unique.push(bar);
        lastTime = bar.time;
      }
    }
    return unique;
  }

  /**
   * 快速讀取某商品最後 N 根日 K
   */
  readLastNBars(symbol, n = 756) {
    const bars = this.readBars(symbol);
    return bars.slice(-n);
  }

  /**
   * 自動偵測 entry（fallback）
   * 以 price range 啟發式識別常見商品
   */
  _detectEntries(symbol) {
    const sym = symbol.toUpperCase();
    // 嘗試名稱前綴比對
    for (const [knownSym, map] of Object.entries(KNOWN_SYMBOL_ENTRIES)) {
      if (sym.startsWith(knownSym.replace(/[0-9]/g, ""))) {
        return [map.daily];
      }
    }
    return [];
  }
}

// ── 預設 QMD 路徑 ────────────────────────────────────────────────
export const DEFAULT_QMD_PATH =
  "D:/群益及元大API/群益國內三年歷史資料包x64_202508/國內三年歷史資料包/群益MC12x64內期歷史資料包_20241212.qmd";

/**
 * 便捷函數：直接讀取 TXF1 K 棒（適合回測）
 * @param {object} opts  同 QmdReader.readBars opts
 */
export async function fetchTxf1Bars(opts = {}) {
  const reader = QmdReader.open(DEFAULT_QMD_PATH);
  return reader.readBars("TXF1", opts);
}

/**
 * 便捷函數：讀取最近 N 日 TXF1 日 K
 */
export async function fetchTxf1Daily(n = 756) {
  const reader = QmdReader.open(DEFAULT_QMD_PATH);
  return reader.readLastNBars("TXF1", n);
}
