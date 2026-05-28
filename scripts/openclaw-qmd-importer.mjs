/**
 * openclaw-qmd-importer.mjs
 *
 * 群益 MultiCharts QMD 歷史資料包匯入器
 *
 * ════ 逆向工程結果（最終確認版）════════════════════════════════════════════
 *
 * QMD 檔案結構：
 *   - 魔術字節: "QMD\0"
 *   - 主要索引表: offset 28, 38 entries × 40 bytes
 *   - 每個 entry 的 fileOffset 指向一個 zlib 壓縮的資料塊
 *   - 每個資料塊：解壓後直接是 K 棒記錄，無 block-level header
 *
 * 記錄格式（88 bytes per bar，NO header）：
 *   +0  .. +7:  FILETIME (uint64 LE)，自訂紀元，所有 bar 均有效 ← 主要時間戳
 *   +8  .. +15: open  (double LE)
 *   +16 .. +23: high  (double LE)
 *   +24 .. +31: low   (double LE)
 *   +32 .. +39: close (double LE)
 *   +40 .. +47: volume (int64 LE)
 *   +48 .. +51: OLE 日期序號 (int32 LE)，僅約 50% 的 bar 有效（metadata only）
 *   +52 .. +87: 其他 metadata
 *
 * FILETIME 解碼（自訂紀元 = 599,890,167,714,505,728）：
 *   ticks = FILETIME - CUSTOM_EPOCH   (100ns intervals from custom epoch)
 *   dayOLE  = Math.floor(ticks / TICKS_PER_DAY)   → OLE serial → ISO date
 *   minOfDay = Math.floor((ticks % TICKS_PER_DAY) / TICKS_PER_MIN)
 *
 * 驗證資料點：
 *   bar[0] FILETIME = 638,956,791,714,505,728
 *   → (638956791714505728 - 599890167714505728) / 864000000000 = 45216 = 2023-10-17 ✓
 *   連續 bar FILETIME 差 = 600,007,680 × 100ns ≈ 60 秒 → 1 分鐘 K 棒 ✓
 *
 * 用法：
 *   node scripts/openclaw-qmd-importer.mjs --list
 *   node scripts/openclaw-qmd-importer.mjs --import
 *   node scripts/openclaw-qmd-importer.mjs --import --symbol TXF,MXF
 *   node scripts/openclaw-qmd-importer.mjs --merge
 *   node scripts/openclaw-qmd-importer.mjs --probe  （顯示各區塊前 5 筆 bar）
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);

// ─── 常數 ──────────────────────────────────────────────────────────────────

/** 88-byte 記錄大小（逆向工程確認） */
const REC = 88;

/** FILETIME 自訂紀元（100ns intervals，對應 OLE day 0 = 1899-12-30） */
const CUSTOM_EPOCH = 599_890_167_714_505_728n;
const TICKS_PER_DAY = 864_000_000_000n;
const TICKS_PER_MIN = 600_000_000n;

/**
 * QMD FILETIME 解碼後得到 UTC 時間。
 * 台灣時間 TWT = UTC + 8 小時（UTC+8）。
 * 策略引擎使用 TWT，故匯出時統一轉換。
 *
 * TXF 交易時段（TWT）：
 *   日盤（Day session） : 08:45 ~ 13:45
 *   夜盤（Night session）: 15:00 ~ 次日 05:00
 *
 * 等效 UTC 時段：
 *   日盤 UTC: 00:45 ~ 05:45
 *   夜盤 UTC: 07:00 ~ 21:00
 */
const TWT_OFFSET_MIN = 8 * 60; // +480 分鐘
const DAY_SESSION_START_TWT_MIN = 8 * 60 + 45; // 08:45
const DAY_SESSION_END_TWT_MIN = 13 * 60 + 45; // 13:45

/** QMD 索引表 */
const INDEX_START = 28;
const ENTRY_SIZE = 40;
/** 動態偵測，最大支援 20000 個 entry */
const MAX_ENTRIES = 20000;

const QMD_FILES = {
  domestic: path.join(
    "D:",
    "群益及元大API",
    "群益國內三年歷史資料包x64_202508",
    "國內三年歷史資料包",
    "群益MC12x64內期歷史資料包_20241212.qmd",
  ),
  domestic2025: path.join(
    "D:",
    "群益及元大API",
    "群益2025內外期歷史資料包",
    "群益 2025 內外期歷史資料包.qmd",
  ),
};

/**
 * 商品價格範圍識別表（靜態上下界，僅作第一道篩選）
 *
 * 重要：detectSymbolProfile() 按 Object.entries 插入順序依序比對，遇第一個相符即回傳。
 * 範圍有重疊時，請把更精確（範圍更窄）的商品排在前面。
 *
 * TXF/MXF 的靜態範圍改用極寬（3000-26000），實際過濾由
 * TXF_MONTHLY_RANGES（日期感知驗證）負責，以解決 NQ 污染問題。
 */
const PRICE_PROFILES = {
  // ── 台灣國內期貨（先比對）───────────────────────────────────────────────
  TXF: { min: 3000, max: 26000, name: "台指期（大台）" },
  MXF: { min: 3000, max: 26000, name: "台指期（小台）" },
  FXF: { min: 500, max: 3000, name: "金融期" },
  EXF: { min: 200, max: 1200, name: "電子期" },
  ZEF: { min: 200, max: 1200, name: "電子期（其他）" },
  ZFF: { min: 500, max: 3000, name: "金融期（其他）" },

  // ── 海外期貨（不與國內重疊，或在國內之後比對）────────────────────────
  ES: { min: 1000, max: 7000, name: "S&P 500 期貨" },
  NQ: { min: 2000, max: 23000, name: "Nasdaq 100 期貨" },
  YM: { min: 20000, max: 50000, name: "DJIA 期貨" },
  HSI: { min: 14000, max: 36000, name: "恆生指數期貨" },
  HHI: { min: 8000, max: 20000, name: "H股指數期貨" },
  CL: { min: 10, max: 200, name: "原油期貨" },
  GC: { min: 800, max: 4000, name: "黃金期貨" },
  SI: { min: 5, max: 80, name: "白銀期貨" },
};

/**
 * TXF（台指期）月度價格合理範圍（日期感知驗證）
 *
 * 資料來源：台灣加權指數歷史收盤資料（加寬 ±10% 容許誤差）
 * 格式：{ "YYYY-MM": [min, max] }
 *
 * 用途：在 detectSymbolProfile() 識別為 TXF 後，進一步驗證是否符合
 * 該月份的合理價格區間，排除被誤識為 TXF 的 NQ/HSI/其他海外期貨。
 */
const TXF_MONTHLY_RANGES = buildTxfMonthlyRanges();

function buildTxfMonthlyRanges() {
  // [年份, 1月最低, 12月最高, 每月粗略 min/max 對照]
  // 格式：[ [YYYY, MM, min, max], ... ]
  // 數值為加寬 ±10% 後的安全範圍
  const rows = [
    // ── 2016 ──────────────────────────────────────
    [2016, 1, 7500, 9500],
    [2016, 2, 7800, 9200],
    [2016, 3, 8100, 9400],
    [2016, 4, 8200, 9500],
    [2016, 5, 8000, 9300],
    [2016, 6, 7800, 9000],
    [2016, 7, 8500, 9400],
    [2016, 8, 8400, 9400],
    [2016, 9, 8600, 9700],
    [2016, 10, 8900, 9600],
    [2016, 11, 8700, 9500],
    [2016, 12, 9100, 9900],
    // ── 2017 ──────────────────────────────────────
    [2017, 1, 9400, 10200],
    [2017, 2, 9500, 10300],
    [2017, 3, 9700, 10500],
    [2017, 4, 9700, 10300],
    [2017, 5, 9700, 10400],
    [2017, 6, 9800, 10700],
    [2017, 7, 9900, 10700],
    [2017, 8, 9800, 10800],
    [2017, 9, 10200, 11100],
    [2017, 10, 10400, 11100],
    [2017, 11, 10400, 11000],
    [2017, 12, 10300, 11000],
    // ── 2018 ──────────────────────────────────────
    [2018, 1, 10700, 11700],
    [2018, 2, 9900, 11700],
    [2018, 3, 9800, 11300],
    [2018, 4, 10000, 11200],
    [2018, 5, 10000, 11400],
    [2018, 6, 9700, 11400],
    [2018, 7, 10200, 11300],
    [2018, 8, 9800, 11000],
    [2018, 9, 9700, 11200],
    [2018, 10, 9200, 11500],
    [2018, 11, 9500, 10500],
    [2018, 12, 8700, 10200],
    // ── 2019 ──────────────────────────────────────
    [2019, 1, 8700, 10100],
    [2019, 2, 9600, 10500],
    [2019, 3, 9800, 10900],
    [2019, 4, 10500, 11600],
    [2019, 5, 10000, 11700],
    [2019, 6, 10300, 10900],
    [2019, 7, 10200, 11100],
    [2019, 8, 9700, 11100],
    [2019, 9, 9800, 11000],
    [2019, 10, 10000, 11400],
    [2019, 11, 11000, 12200],
    [2019, 12, 11200, 12500],
    // ── 2020 ──────────────────────────────────────
    [2020, 1, 11800, 12800],
    [2020, 2, 9900, 12800],
    [2020, 3, 8300, 11400],
    [2020, 4, 9400, 11200],
    [2020, 5, 9600, 11200],
    [2020, 6, 10800, 11900],
    [2020, 7, 11500, 13000],
    [2020, 8, 12000, 13500],
    [2020, 9, 12500, 13500],
    [2020, 10, 12600, 13400],
    [2020, 11, 13000, 14300],
    [2020, 12, 13500, 15000],
    // ── 2021 ──────────────────────────────────────
    [2021, 1, 14500, 16800],
    [2021, 2, 16000, 18000],
    [2021, 3, 15500, 17700],
    [2021, 4, 16500, 18000],
    [2021, 5, 15500, 18500],
    [2021, 6, 16000, 18500],
    [2021, 7, 15500, 18100],
    [2021, 8, 16200, 17800],
    [2021, 9, 15800, 17700],
    [2021, 10, 15500, 17600],
    [2021, 11, 15700, 17800],
    [2021, 12, 16500, 18500],
    // ── 2022 ──────────────────────────────────────
    [2022, 1, 16500, 18500],
    [2022, 2, 16000, 18500],
    [2022, 3, 16500, 18600],
    [2022, 4, 16200, 18500],
    [2022, 5, 14900, 18200],
    [2022, 6, 13800, 17200],
    [2022, 7, 13500, 16600],
    [2022, 8, 14200, 16500],
    [2022, 9, 13200, 15800],
    [2022, 10, 13100, 15200],
    [2022, 11, 13500, 15100],
    [2022, 12, 13500, 15400],
    // ── 2023 ──────────────────────────────────────
    [2023, 1, 14000, 16000],
    [2023, 2, 14800, 16500],
    [2023, 3, 14800, 16400],
    [2023, 4, 15000, 16500],
    [2023, 5, 15500, 17300],
    [2023, 6, 15800, 17700],
    [2023, 7, 16000, 17700],
    [2023, 8, 16000, 17500],
    [2023, 9, 15700, 17000],
    [2023, 10, 15200, 16900],
    [2023, 11, 16200, 17900],
    [2023, 12, 16600, 18000],
    // ── 2024 ──────────────────────────────────────
    [2024, 1, 16200, 19000],
    [2024, 2, 18000, 20800],
    [2024, 3, 19000, 21000],
    [2024, 4, 19000, 21500],
    [2024, 5, 20000, 22500],
    [2024, 6, 20500, 23000],
    [2024, 7, 20000, 24500],
    [2024, 8, 19500, 24000],
    [2024, 9, 21000, 23500],
    [2024, 10, 21500, 23500],
    [2024, 11, 21000, 23500],
    [2024, 12, 21000, 23500],
  ];

  const map = {};
  for (const [y, m, lo, hi] of rows) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    map[key] = [lo, hi];
  }
  return map;
}

/**
 * 判斷給定日期的 OPEN 價格是否符合 TXF 歷史合理範圍。
 *
 * 優先使用月度精確範圍；若超出月度表範圍（pre-2016 或 post-2024），
 * 則使用年度寬泛範圍（以 TAIEX 年度高低點為基礎）。
 *
 * @param {string} date   ISO 日期字串 "YYYY-MM-DD"
 * @param {number} price  OPEN 價格（已 decimal 修正）
 * @returns {boolean}
 */
function isValidTxfPrice(date, price) {
  if (!date || price <= 0) {
    return false;
  }

  const ym = date.slice(0, 7); // "YYYY-MM"
  const monthly = TXF_MONTHLY_RANGES[ym];
  if (monthly) {
    return price >= monthly[0] && price <= monthly[1];
  }

  // 月度表以外：以寬鬆年度範圍兜底（1996-2015）
  const year = Number.parseInt(date.slice(0, 4), 10);
  const yearRanges = {
    1996: [4000, 9000],
    1997: [5000, 11000],
    1998: [5000, 10000],
    1999: [4500, 10000],
    2000: [4000, 11000],
    2001: [3300, 7500],
    2002: [3500, 6500],
    2003: [3500, 6700],
    2004: [5000, 8000],
    2005: [5500, 7200],
    2006: [5800, 8500],
    2007: [6200, 10200],
    2008: [3700, 10000],
    2009: [4500, 8700],
    2010: [6800, 9600],
    2011: [6400, 9500],
    2012: [6500, 8300],
    2013: [7200, 9400],
    2014: [8000, 10200],
    2015: [7700, 10600],
  };
  const yr = yearRanges[year];
  if (yr) {
    return price >= yr[0] && price <= yr[1];
  }

  // 未知年份：接受
  return true;
}

// ─── UTC 分鐘偏移 → TWT 日期時間 ───────────────────────────────────────────

/**
 * 將 UTC 的 OLE daySerial + minOfDay 轉換為 TWT 日期時間
 * @param {number} dayOLE    - OLE 日期序號（UTC 日）
 * @param {number} minOfDay  - 當日 UTC 分鐘偏移
 * @returns {{ date: string, time: string, minOfDayTwt: number } | null}
 */
function utcToTwt(dayOLE, minOfDay) {
  const totalMinUtc = dayOLE * 1440 + minOfDay; // 從 OLE epoch 起算的 UTC 分鐘
  const totalMinTwt = totalMinUtc + TWT_OFFSET_MIN;
  const twtDaySerial = Math.floor(totalMinTwt / 1440);
  const twtMinOfDay = totalMinTwt % 1440;

  const dateStr = oleSerial2Date(twtDaySerial);
  if (!dateStr) {
    return null;
  }

  const hour = Math.floor(twtMinOfDay / 60);
  const minute = twtMinOfDay % 60;
  if (hour > 23 || minute > 59) {
    return null;
  }

  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { date: dateStr, time: timeStr, minOfDayTwt: twtMinOfDay };
}

// ─── OLE 日期序號 → ISO 日期字串 ──────────────────────────────────────────

function oleSerial2Date(serial) {
  if (serial < 30000 || serial > 60000) {
    return null;
  }
  const BASE_MS = Date.UTC(1899, 11, 30, 0, 0, 0, 0); // 1899-12-30
  const d = new Date(BASE_MS + serial * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ─── FILETIME 解碼 ─────────────────────────────────────────────────────────

/**
 * 將 88-byte 記錄中 offset+0 的 uint64 FILETIME 轉換為**台灣時間（TWT = UTC+8）**日期時間
 *
 * QMD FILETIME 使用自訂紀元（CUSTOM_EPOCH = OLE day 0 = 1899-12-30 00:00 UTC）。
 * 解碼後先得到 UTC dayOLE + minOfDay，再加 8 小時轉為 TWT。
 *
 * @returns {{ date: string, time: string, minOfDayTwt: number } | null}
 */
function decodeFiletime(ft) {
  if (ft <= CUSTOM_EPOCH) {
    return null;
  }
  const ticks = ft - CUSTOM_EPOCH;
  const dayOLE = Number(ticks / TICKS_PER_DAY);
  const minOfDay = Number((ticks % TICKS_PER_DAY) / TICKS_PER_MIN);
  return utcToTwt(dayOLE, minOfDay);
}

// ─── 嘗試解壓縮 ───────────────────────────────────────────────────────────

async function tryInflate(buf) {
  try {
    return await inflate(buf);
  } catch {
    return null;
  }
}

// ─── 商品目錄解析 ──────────────────────────────────────────────────────────

async function loadCatalog(qmdPath) {
  const fd = fs.openSync(qmdPath, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const data = buf.slice(0, n);

  for (let i = 0; i < Math.min(data.length - 2, 10000); i++) {
    const b = data[i],
      b1 = data[i + 1];
    if (b === 0x78 && (b1 === 0x9c || b1 === 0xda || b1 === 0x01)) {
      const dec = await tryInflate(data.slice(i));
      if (dec && dec[0] === 0x3c) {
        // '<' XML
        const xml = dec.toString("utf8");
        const symbols = parseSymbolXml(xml);
        return { symbols, xmlOffset: i };
      }
    }
  }
  return null;
}

function parseSymbolXml(xml) {
  const syms = [];
  const re = /<symbol\s+([^>]+)\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const a = {};
    const ar = /(\w+)="([^"]*)"/g;
    let am;
    while ((am = ar.exec(m[1])) !== null) {
      a[am[1]] = am[2];
    }
    syms.push({
      id: Number(a.id || 0),
      symbolName: a.symbolName || "",
      symbolRoot: a.symbolRoot || "",
      category: Number(a.category || 0),
    });
  }
  return syms;
}

// ─── 索引表解析（動態偵測條目數）─────────────────────────────────────────

function parseIndexTable(buf, fileSize) {
  const entries = [];
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const off = INDEX_START + i * ENTRY_SIZE;
    if (off + ENTRY_SIZE > buf.length) {
      break;
    }
    const fileOffset = buf.readUInt32LE(off + 36);
    // fileOffset=0 可能是 sentinel（結束標記）；也接受非零且在檔案範圍內的值
    if (fileOffset === 0) {
      continue;
    } // skip empty
    if (fileOffset >= fileSize) {
      continue;
    } // 超出檔案範圍
    entries.push({ seq: i, fileOffset });
  }
  return entries;
}

// ─── 資料塊解壓縮 ─────────────────────────────────────────────────────────

async function loadBlock(qmdPath, fileOffset) {
  const fd = fs.openSync(qmdPath, "r");
  const hdr = Buffer.alloc(8);
  fs.readSync(fd, hdr, 0, 8, fileOffset);

  const compSize = hdr.readUInt32LE(4);
  if (compSize <= 0 || compSize > 256 * 1024 * 1024) {
    fs.closeSync(fd);
    return null;
  }

  const compBuf = Buffer.alloc(Math.min(compSize, 64 * 1024 * 1024));
  fs.readSync(fd, compBuf, 0, compBuf.length, fileOffset + 8);
  fs.closeSync(fd);

  return tryInflate(compBuf);
}

// ─── 偵測商品類型（掃描前幾筆有效記錄找 OHLC doubles）─────────────────

/**
 * 從解壓縮的 block 資料偵測商品類型。
 *
 * 流程：
 *  1. 跳過 FILETIME 無效的 sentinel 記錄（如第一筆 ft=13312）
 *  2. 依 PRICE_PROFILES 靜態範圍初步比對
 *  3. 若命中 TXF/MXF，再呼叫 isValidTxfPrice() 以日期感知方式二次驗證
 *     → 防止 NQ/HSI 因價格重疊被誤識為 TXF
 *  4. 若 TXF 二次驗證失敗，繼續嘗試其他 profiles（NQ、HSI 等）
 *
 * @param {Buffer} data  解壓縮後的原始資料
 * @returns {{ root: string, profile: object } | null}
 */
function detectSymbolProfile(data) {
  // 從前 20 筆有效記錄中收集 (date, open) 樣本，再做投票式比對
  const candidates = [];

  for (let recStart = 0; recStart < Math.min(data.length, REC * 20); recStart += REC) {
    if (recStart + REC > data.length) {
      break;
    }

    const ft = data.readBigUInt64LE(recStart + 0);
    if (ft <= CUSTOM_EPOCH) {
      continue;
    }

    const openVal = data.readDoubleLE(recStart + 8);
    if (!Number.isFinite(openVal) || openVal <= 0) {
      continue;
    }

    const ts = decodeFiletime(ft);
    if (!ts) {
      continue;
    }

    candidates.push({ date: ts.date, open: openVal });
    if (candidates.length >= 5) {
      break;
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // ── 逐 candidate 嘗試識別 ─────────────────────────────────────────────
  const votes = {}; // { root: count }

  for (const { date, open } of candidates) {
    for (const [root, profile] of Object.entries(PRICE_PROFILES)) {
      if (open < profile.min || open > profile.max) {
        continue;
      }

      // TXF/MXF 需要額外日期感知驗證
      if (root === "TXF" || root === "MXF") {
        if (!isValidTxfPrice(date, open)) {
          continue;
        }
      }

      votes[root] = (votes[root] || 0) + 1;
      break; // 一筆 candidate 只對應第一個符合的 profile
    }
  }

  if (Object.keys(votes).length === 0) {
    return null;
  }

  // 取票數最多的商品（多數決）
  const best = Object.entries(votes).toSorted((a, b) => b[1] - a[1])[0];
  const root = best[0];
  return { root, profile: PRICE_PROFILES[root] };
}

// ─── 核心 K 棒解析（88-byte 固定格式，FILETIME 主要時間戳）──────────────

/**
 * 解析一個解壓縮後的資料塊
 * @param {Buffer} data     解壓縮後的原始 bytes
 * @param {string} symbol   商品代碼（如 "TXF"）
 * @param {object} profile  { min, max } 價格範圍
 * @returns {Array}         K 棒陣列
 */
function parseBlock(data, symbol, profile) {
  const totalRecs = Math.floor(data.length / REC);
  if (totalRecs < 2) {
    return [];
  }

  const bars = [];

  for (let i = 0; i < totalRecs; i++) {
    const base = i * REC;
    if (base + REC > data.length) {
      break;
    }

    // OHLCV
    const open = data.readDoubleLE(base + 8);
    const high = data.readDoubleLE(base + 16);
    const low = data.readDoubleLE(base + 24);
    const close = data.readDoubleLE(base + 32);
    const volume = Number(data.readBigInt64LE(base + 40));

    // OHLC 合理性驗證（先做靜態範圍過濾，再做日期感知過濾）
    if (open < profile.min || open > profile.max) {
      continue;
    }
    if (high < profile.min || high > profile.max) {
      continue;
    }
    if (low < profile.min || low > profile.max) {
      continue;
    }
    if (close < profile.min || close > profile.max) {
      continue;
    }
    if (high < low) {
      continue;
    }
    if (high < Math.max(open, close) * 0.98) {
      continue;
    }
    if (low > Math.min(open, close) * 1.02) {
      continue;
    }
    if (volume < 0 || volume > 10_000_000) {
      continue;
    }

    // FILETIME 解碼（主要時間戳，offset +0：每筆 record 的前 8 bytes）
    const ft = data.readBigUInt64LE(base + 0);
    const ts = decodeFiletime(ft);
    if (!ts) {
      continue;
    }

    // TXF/MXF：日期感知二次驗證（排除 NQ/HSI 污染記錄）
    if ((symbol === "TXF" || symbol === "MXF") && !isValidTxfPrice(ts.date, open)) {
      continue;
    }

    const inDaySession =
      ts.minOfDayTwt >= DAY_SESSION_START_TWT_MIN && ts.minOfDayTwt <= DAY_SESSION_END_TWT_MIN;

    bars.push({
      symbol,
      date: ts.date,
      time: ts.time,
      inDaySession,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });
  }

  return bars;
}

// ─── 主要匯入函式 ──────────────────────────────────────────────────────────

export async function importQmdHistory(options = {}) {
  const {
    qmdPath = QMD_FILES.domestic,
    outDir = path.join(process.cwd(), ".openclaw", "bars", "qmd"),
    targetSymbols = null, // null = all, or ['TXF', 'MXF']
    verbose = false,
  } = options;

  if (!fs.existsSync(qmdPath)) {
    return { status: "no_qmd", qmdPath, message: `QMD 檔案不存在: ${qmdPath}` };
  }

  const fileSize = fs.statSync(qmdPath).size;
  await fsp.mkdir(outDir, { recursive: true });

  // 讀取 QMD 主檔頭（最多 600KB，支援 2025 版大索引表 ~13011 entries × 40B = 521KB）
  const HDR_READ = Math.min(fileSize, 600 * 1024);
  const headerBuf = Buffer.alloc(HDR_READ);
  const fd0 = fs.openSync(qmdPath, "r");
  fs.readSync(fd0, headerBuf, 0, HDR_READ, 0);
  fs.closeSync(fd0);

  // 驗證魔術字節
  const magic = headerBuf.slice(0, 4).toString("ascii");
  if (!magic.startsWith("QMD")) {
    if (verbose) {
      console.warn(`  ⚠ 魔術字節不符: ${JSON.stringify(magic)}`);
    }
  }

  // 解析索引表（動態偵測條目數）
  const indexEntries = parseIndexTable(headerBuf, fileSize);
  if (verbose) {
    console.log(`索引條目: ${indexEntries.length} 個`);
  }

  const results = [];
  let totalBars = 0;

  for (let i = 0; i < indexEntries.length; i++) {
    const entry = indexEntries[i];
    if (entry.fileOffset <= 0 || entry.fileOffset >= fileSize) {
      continue;
    }

    if (verbose) {
      process.stdout.write(`  處理區塊 ${i + 1}/${indexEntries.length} @${entry.fileOffset}  \r`);
    }

    const data = await loadBlock(qmdPath, entry.fileOffset);
    if (!data || data.length < REC) {
      continue;
    }

    // 識別商品類型
    const detected = detectSymbolProfile(data);
    if (!detected) {
      continue;
    }

    const { root: symbolRoot, profile } = detected;

    // 過濾指定商品
    if (targetSymbols && !targetSymbols.some((s) => symbolRoot.startsWith(s))) {
      continue;
    }

    // 解析 K 棒
    const bars = parseBlock(data, symbolRoot, profile);
    if (bars.length < 2) {
      continue;
    }

    // 統計
    const dates = [...new Set(bars.map((b) => b.date))].toSorted((a, b) => a.localeCompare(b));
    const dateRange = dates.length > 0 ? `${dates[0]}~${dates[dates.length - 1]}` : "??";

    if (verbose) {
      console.log(
        `  [B${i}] ${symbolRoot.padEnd(4)} ${profile.name}: ` +
          `${bars.length} bars, ${dates.length} days, ${dateRange}`,
      );
    }

    // 寫入 JSONL
    const outFile = path.join(outDir, `${symbolRoot}-block${i}-bars.jsonl`);
    await fsp.writeFile(outFile, bars.map((b) => JSON.stringify(b)).join("\n") + "\n", "utf8");

    results.push({
      block: i,
      symbol: symbolRoot,
      name: profile.name,
      bars: bars.length,
      days: dates.length,
      dateRange,
      recSize: REC,
      file: path.relative(process.cwd(), outFile),
    });
    totalBars += bars.length;
  }

  if (verbose) {
    console.log(`\n匯入完成: ${results.length} 個區塊, ${totalBars} 筆 K 棒`);
  }

  return {
    status: "ok",
    qmdPath,
    totalBlocks: results.length,
    totalBars,
    blocks: results,
    outDir,
  };
}

// ─── 合併同商品 K 棒 ───────────────────────────────────────────────────────

export async function mergeSymbolBars(qmdOutDir, mergedDir) {
  await fsp.mkdir(mergedDir, { recursive: true });
  const files = fs.readdirSync(qmdOutDir).filter((f) => f.endsWith("-bars.jsonl"));

  // 按商品分組
  const bySymbol = {};
  for (const f of files) {
    const m = f.match(/^([A-Z]+)-block\d+-bars\.jsonl$/);
    if (!m) {
      continue;
    }
    const sym = m[1];
    (bySymbol[sym] = bySymbol[sym] || []).push(path.join(qmdOutDir, f));
  }

  const results = [];
  for (const [sym, filePaths] of Object.entries(bySymbol)) {
    // ── 按 date+time 逐行串流合併（避免 OOM）──
    // 策略：先收集每個 block 的第一行 date（用於排序），再依序讀取

    // 1. 取每個檔案的首筆 bar 日期，排序 filePaths
    const fileHeaders = [];
    for (const fp of filePaths) {
      let firstDate = "9999-99-99T99:99";
      try {
        const fd = fs.openSync(fp, "r");
        const buf = Buffer.alloc(256);
        const n = fs.readSync(fd, buf, 0, 256, 0);
        fs.closeSync(fd);
        const line = buf.slice(0, n).toString("utf8").split("\n")[0];
        const bar = JSON.parse(line);
        firstDate = `${bar.date}T${bar.time}`;
      } catch {}
      fileHeaders.push({ fp, firstDate });
    }
    fileHeaders.sort((a, b) => a.firstDate.localeCompare(b.firstDate));

    // 2. 逐一讀取，用 Set 去重，分批寫出（每 10 萬筆 flush 一次）
    const outFile = path.join(mergedDir, `${sym}-qmd-1m.jsonl`);
    const outStream = fs.createWriteStream(outFile, { flags: "w" });
    const seen = new Set(); // key = "YYYY-MM-DDTHH:MM"
    let totalBars = 0;
    let firstDate = "";
    let lastDate = "";
    const CHUNK = 100_000;
    let chunk = [];

    const flushChunk = async () => {
      if (chunk.length === 0) {
        return;
      }
      // 排序 chunk，再寫出
      chunk.sort((a, b) => {
        const c = a.date.localeCompare(b.date);
        return c !== 0 ? c : a.time.localeCompare(b.time);
      });
      for (const bar of chunk) {
        outStream.write(JSON.stringify(bar) + "\n");
      }
      chunk = [];
    };

    for (const { fp } of fileHeaders) {
      try {
        const content = await fsp.readFile(fp, "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          let bar;
          try {
            bar = JSON.parse(line);
          } catch {
            continue;
          }
          const key = `${bar.date}T${bar.time}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          chunk.push(bar);
          totalBars++;
          if (!firstDate) {
            firstDate = bar.date;
          }
          lastDate = bar.date;
          if (chunk.length >= CHUNK) {
            await flushChunk();
          }
        }
      } catch {}
    }
    await flushChunk();
    await new Promise((resolve) => outStream.end(resolve));

    const uniqueDays = new Set([...seen].map((k) => k.slice(0, 10))).size;
    const info = {
      symbol: sym,
      bars: totalBars,
      days: uniqueDays,
      dateRange: `${firstDate}~${lastDate}`,
      file: outFile,
    };
    results.push(info);
    console.log(
      `  ${sym}: ${totalBars.toLocaleString()} bars, ${uniqueDays} days, ${info.dateRange}`,
    );
  }

  return results;
}

// ─── 合併兩個已合併的 JSONL 檔案（最終去重）─────────────────────────────

/**
 * 把兩個（或多個）已 merge 的 TXF-qmd-1m.jsonl 合併為一份，
 * 依 date+time 去重並排序後寫出。
 *
 * @param {string[]} inputFiles  輸入 JSONL 檔案路徑陣列
 * @param {string}   outputFile  輸出 JSONL 路徑
 */
export async function combineMergedJsonl(inputFiles, outputFile) {
  const { createInterface } = await import("node:readline");
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });

  console.log(`\n合併 JSONL 檔案:`);
  for (const f of inputFiles) {
    const stat = fs.statSync(f);
    console.log(`  輸入: ${f} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }

  // 逐行讀取所有輸入，存入 Map（key=date+time，後出現的覆蓋先出現的）
  // 為節省記憶體，先收集 key→line，最後排序後輸出
  const barMap = new Map(); // key → JSON string (raw line)

  for (const inFile of inputFiles) {
    const rl = createInterface({
      input: fs.createReadStream(inFile, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let lineNo = 0;
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      try {
        const bar = JSON.parse(line);
        const key = `${bar.date}T${bar.time}`;
        // 若已存在，保留 volume 較大的那筆（通常是更完整的資料）
        if (barMap.has(key)) {
          const existing = JSON.parse(barMap.get(key));
          if (bar.volume > existing.volume) {
            barMap.set(key, line);
          }
        } else {
          barMap.set(key, line);
        }
        lineNo++;
      } catch {
        /* skip malformed lines */
      }
    }
    console.log(`  ${path.basename(inFile)}: 讀取 ${lineNo.toLocaleString()} 行`);
  }

  console.log(`  去重後共 ${barMap.size.toLocaleString()} 筆 bar`);

  // 依 key 排序後輸出
  const keys = Array.from(barMap.keys()).toSorted((a, b) => a.localeCompare(b));
  const outStream = fs.createWriteStream(outputFile, { flags: "w" });

  let written = 0;
  let firstDate = "";
  let lastDate = "";

  for (const key of keys) {
    const line = barMap.get(key);
    outStream.write(line + "\n");
    written++;
    if (written === 1) {
      firstDate = key.slice(0, 10);
    }
    lastDate = key.slice(0, 10);
  }

  await new Promise((resolve) => outStream.end(resolve));

  const outStat = fs.statSync(outputFile);
  // 計算唯一天數
  const uniqueDays = new Set(keys.map((k) => k.slice(0, 10))).size;
  console.log(`\n  ✅ 輸出: ${outputFile}`);
  console.log(
    `     ${written.toLocaleString()} bars, ${uniqueDays} days, ${firstDate}~${lastDate}`,
  );
  console.log(`     檔案大小: ${(outStat.size / 1024 / 1024).toFixed(1)} MB`);
  return { bars: written, days: uniqueDays, firstDate, lastDate, outputFile };
}

// ─── Probe：顯示各區塊前 5 筆 bar（除錯用）───────────────────────────────

async function probeAllBlocks(qmdPath, verbose = true) {
  const fileSize = fs.statSync(qmdPath).size;
  const HDR_READ = Math.min(fileSize, 600 * 1024);
  const headerBuf = Buffer.alloc(HDR_READ);
  const fd0 = fs.openSync(qmdPath, "r");
  fs.readSync(fd0, headerBuf, 0, HDR_READ, 0);
  fs.closeSync(fd0);

  const indexEntries = parseIndexTable(headerBuf, fileSize);
  console.log(`\n═══ QMD Probe: ${qmdPath} ═══`);
  console.log(`檔案大小: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`索引條目: ${indexEntries.length}`);

  for (let i = 0; i < indexEntries.length; i++) {
    const entry = indexEntries[i];
    if (entry.fileOffset <= 0 || entry.fileOffset >= fileSize) {
      continue;
    }

    const data = await loadBlock(qmdPath, entry.fileOffset);
    if (!data) {
      continue;
    }

    const totalRecs = Math.floor(data.length / REC);
    const detected = detectSymbolProfile(data);

    if (!detected) {
      if (verbose) {
        console.log(
          `  [B${i}] @${entry.fileOffset}: ${data.length} bytes, ${totalRecs} recs, 無法識別商品`,
        );
      }
      continue;
    }

    const { root, profile } = detected;
    console.log(
      `\n  [B${i}] @${entry.fileOffset}: ${data.length} bytes = ${totalRecs} recs × ${REC}B | ${root} ${profile.name}`,
    );

    // 顯示前 5 筆
    const bars = parseBlock(data, root, profile);
    for (const bar of bars.slice(0, 5)) {
      console.log(
        `    ${bar.date} ${bar.time}  O=${bar.open}  H=${bar.high}  L=${bar.low}  C=${bar.close}  V=${bar.volume}`,
      );
    }
    if (bars.length === 0) {
      console.log(`    ⚠ 無有效 bar（OHLC 驗證全部失敗）`);
    }
  }
}

// ─── 索引條目結構分析（診斷用）────────────────────────────────────────────

/**
 * 分析 QMD 索引表每個 40-byte entry 的原始欄位，找出 symbol ID 映射規律。
 * 同時載入 catalog XML 對照。
 *
 * @param {string} qmdPath   QMD 檔案路徑
 * @param {number} maxRows   最多輸出幾行（預設 80）
 * @param {number} skipEmpty 是否跳過空 / 無效 entry（預設 true）
 */
async function analyzeIndexEntries(qmdPath, maxRows = 80, skipEmpty = true, startSeq = 0) {
  const fileSize = fs.statSync(qmdPath).size;
  const HDR_READ = Math.min(fileSize, 600 * 1024);
  const headerBuf = Buffer.alloc(HDR_READ);
  const fd0 = fs.openSync(qmdPath, "r");
  fs.readSync(fd0, headerBuf, 0, HDR_READ, 0);
  fs.closeSync(fd0);

  console.log(`\n═══ QMD 索引條目分析: ${path.basename(qmdPath)} ═══`);
  console.log(`檔案大小: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);

  // ── 載入 catalog XML ──────────────────────────────────────────────────
  const catalog = await loadCatalog(qmdPath);
  if (catalog) {
    console.log(`\nCatalog: ${catalog.symbols.length} 個商品`);
    console.log("前 15 個商品（catalog XML 順序）：");
    catalog.symbols
      .slice(0, 15)
      .forEach((s, i) =>
        console.log(
          `  cat[${String(i).padStart(3)}] id=${String(s.id).padStart(4)} root=${s.symbolRoot.padEnd(6)} name=${s.symbolName} cat=${s.category}`,
        ),
      );
    const txfList = catalog.symbols.filter(
      (s) =>
        s.symbolRoot === "TXF" ||
        s.symbolName.toUpperCase().includes("TXF") ||
        s.symbolRoot === "MXF" ||
        s.symbolRoot === "EXF" ||
        s.symbolRoot === "FXF",
    );
    console.log(`\n台灣期貨相關商品（catalog）: ${txfList.length} 個`);
    txfList
      .slice(0, 20)
      .forEach((s) =>
        console.log(
          `  id=${String(s.id).padStart(4)} root=${s.symbolRoot.padEnd(6)} name=${s.symbolName}`,
        ),
      );
  } else {
    console.log("（無法解析 catalog XML）");
  }

  // ── 分析索引條目原始欄位 ─────────────────────────────────────────────
  console.log(`\n索引條目原始欄位（前 ${maxRows} 個有效條目）：`);
  console.log(
    "seq  | b[0-3]  b[4-7]  b[8-11] b[12-15] b[16-19] b[20-23] b[24-27] b[28-31] b[32-35] b[36-39]=offset | firstBar(TWT)",
  );
  console.log("-".repeat(130));

  let shown = 0;
  for (let i = startSeq; i < MAX_ENTRIES && shown < maxRows; i++) {
    const off = INDEX_START + i * ENTRY_SIZE;
    if (off + ENTRY_SIZE > headerBuf.length) {
      break;
    }

    const fields = [];
    for (let f = 0; f < 10; f++) {
      fields.push(headerBuf.readUInt32LE(off + f * 4));
    }
    const fileOffset = fields[9]; // bytes 36-39

    if (skipEmpty && (fileOffset === 0 || fileOffset >= fileSize)) {
      continue;
    }

    // 嘗試讀第一筆 bar
    let firstBarStr = "??";
    if (fileOffset > 0 && fileOffset < fileSize) {
      try {
        const data = await loadBlock(qmdPath, fileOffset);
        if (data && data.length >= REC) {
          const ft = data.readBigUInt64LE(0);
          const ts = decodeFiletime(ft);
          const open = data.readDoubleLE(8);
          firstBarStr = ts
            ? `${ts.date} ${ts.time} O=${open.toFixed(0)}`
            : `ft=${ft} O=${open.toFixed(0)}`;
        }
      } catch {
        firstBarStr = "err";
      }
    }

    const row =
      `${String(i).padStart(4)} | ` +
      fields.map((v) => String(v).padStart(7)).join(" ") +
      ` | ${firstBarStr}`;
    console.log(row);
    shown++;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const hasFlag = (n) => args.includes(n);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i !== -1 ? args[i + 1] : null;
  };

  const qmdPath = flag("--qmd") || QMD_FILES.domestic;
  const outDir =
    flag("--out-dir") ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".openclaw", "bars", "qmd");

  if (hasFlag("--list")) {
    const catalog = await loadCatalog(qmdPath);
    console.log(`商品目錄（${catalog?.symbols.length || 0} 個）:`);
    catalog?.symbols.forEach((s) =>
      console.log(`  ${s.symbolName.padEnd(12)} root=${s.symbolRoot.padEnd(6)} cat=${s.category}`),
    );
    return;
  }

  if (hasFlag("--probe")) {
    await probeAllBlocks(qmdPath);
    return;
  }

  if (hasFlag("--decode-index")) {
    const maxRowsArg = flag("--rows");
    const startArg = flag("--start");
    const maxRows = maxRowsArg ? Number.parseInt(maxRowsArg, 10) : 80;
    const startSeq = startArg ? Number.parseInt(startArg, 10) : 0;
    await analyzeIndexEntries(qmdPath, maxRows, true, startSeq);
    return;
  }

  if (hasFlag("--import")) {
    const symbolArg = flag("--symbol");
    const symbols = symbolArg ? symbolArg.split(",") : null;
    console.log(`開始匯入 QMD: ${qmdPath}`);
    console.log(`輸出目錄: ${outDir}`);
    if (symbols) {
      console.log(`目標商品: ${symbols.join(", ")}`);
    }

    const result = await importQmdHistory({
      qmdPath,
      outDir,
      targetSymbols: symbols,
      verbose: true,
    });

    if (result.status === "no_qmd") {
      console.error(`❌ ${result.message}`);
      process.exit(1);
    }

    console.log(`\n匯入結果:`);
    result.blocks?.forEach((b) =>
      console.log(
        `  ${b.symbol.padEnd(4)} Block${b.block}: ${b.bars.toLocaleString()} bars, ${b.days} days, ${b.dateRange}`,
      ),
    );
    console.log(`\n總計: ${result.totalBars.toLocaleString()} bars`);
    return;
  }

  if (hasFlag("--merge")) {
    const qmdOutDir = flag("--qmd-out") || outDir;
    const mergedDir =
      flag("--merged-dir") ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".openclaw", "bars");
    console.log(`合併 QMD K 棒: ${qmdOutDir} → ${mergedDir}`);
    const results = await mergeSymbolBars(qmdOutDir, mergedDir);
    console.log(`\n合併完成: ${results.length} 個商品`);
    return;
  }

  if (hasFlag("--combine")) {
    // --combine --inputs A.jsonl,B.jsonl --output final.jsonl
    const inputsArg = flag("--inputs");
    const outputArg = flag("--output");
    if (!inputsArg || !outputArg) {
      console.error("用法: --combine --inputs file1.jsonl,file2.jsonl --output final.jsonl");
      process.exit(1);
    }
    const inputFiles = inputsArg.split(",").map((f) => f.trim());
    await combineMergedJsonl(inputFiles, outputArg);
    return;
  }

  // 預設：快速 probe 前幾個有效區塊
  await probeAllBlocks(qmdPath);
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
