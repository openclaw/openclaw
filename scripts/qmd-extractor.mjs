/**
 * qmd-extractor.mjs
 *
 * 群益 MultiCharts QMD 歷史資料包解析器
 *
 * 格式（已解析）：
 *   offset 0:    "QMD\0" magic (4 bytes)
 *   offset 4:    version uint32 LE = 1
 *   offset 8:    0
 *   offset 12:   1560 (=0x618) — 可能是區塊數量或索引偏移
 *   offset 16:   38 (0x26) — 可能是欄位數或標頭版本
 *   offset 20:   40 (0x28)
 *   offset 1568: zlib 壓縮的 XML 商品目錄
 *   後續:        各商品的 zlib 壓縮 K 棒資料塊
 *
 * 用法：
 *   node scripts/qmd-extractor.mjs --list          (列出所有商品)
 *   node scripts/qmd-extractor.mjs --symbol TXF    (提取台指期 K 棒)
 *   node scripts/qmd-extractor.mjs --all            (提取所有商品)
 *   node scripts/qmd-extractor.mjs --out-dir .openclaw/bars/qmd
 */

import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);

const DEFAULT_DOMESTIC_QMD = path.join(
  "D:",
  "群益及元大API",
  "群益國內三年歷史資料包x64_202508",
  "國內三年歷史資料包",
  "群益MC12x64內期歷史資料包_20241212.qmd",
);

// ─── 工具函式 ─────────────────────────────────────────────────────────────

async function tryDecompress(buf) {
  try {
    return await inflate(buf);
  } catch {}
  try {
    return await inflateRaw(buf);
  } catch {}
  return null;
}

// ─── 商品目錄 XML 解析 ────────────────────────────────────────────────────

function parseSymbolXml(xmlText) {
  const symbols = [];
  const regex = /<symbol\s+([^>]+)\/>/g;
  let m;
  while ((m = regex.exec(xmlText)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) {
      attrs[a[1]] = a[2];
    }
    symbols.push({
      id: Number(attrs.id || 0),
      symbolName: attrs.symbolName || "",
      symbolRoot: attrs.symbolRoot || "",
      description: attrs.description || "",
      category: Number(attrs.category || 0), // 0=futures, 4=index
      dataFeedName: attrs.dataFeedName || "",
      contractMonth: Number(attrs.contractMonth || 0),
      contractYear: Number(attrs.contractYear || 0),
      expired: Number(attrs.expired || 0),
      expirationDate: Number(attrs.expirationDate || 0),
    });
  }
  return symbols;
}

// ─── QMD 結構掃描 ─────────────────────────────────────────────────────────

/**
 * 掃描整個 QMD 文件，找出所有 zlib 壓縮區塊的偏移位置
 * 採用滑動窗口，每次讀 2MB
 */
async function scanAllZlibBlocks(qmdPath) {
  const fileSize = fs.statSync(qmdPath).size;
  const fd = fs.openSync(qmdPath, "r");
  const blocks = [];
  const CHUNK = 2 * 1024 * 1024; // 2MB
  const buf = Buffer.alloc(CHUNK + 4);

  console.log(`掃描 zlib 區塊... (${(fileSize / 1024 / 1024).toFixed(0)} MB)`);
  let offset = 0;
  let reported = 0;
  while (offset < fileSize) {
    const toRead = Math.min(CHUNK + 4, fileSize - offset);
    fs.readSync(fd, buf, 0, toRead, offset);
    for (let i = 0; i < toRead - 1; i++) {
      const b0 = buf[i],
        b1 = buf[i + 1];
      if (b0 === 0x78 && (b1 === 0x9c || b1 === 0x01 || b1 === 0xda || b1 === 0x5e)) {
        blocks.push(offset + i);
      }
    }
    offset += CHUNK;
    const pct = Math.round((offset / fileSize) * 100);
    if (pct >= reported + 10) {
      process.stdout.write(`  ${pct}%\r`);
      reported = pct;
    }
  }
  fs.closeSync(fd);
  console.log(`  找到 ${blocks.length} 個 zlib 區塊`);
  return blocks;
}

// ─── K 棒資料二進位解析 ───────────────────────────────────────────────────

/**
 * 嘗試從解壓縮後的資料解析 OHLCV K 棒
 * MultiCharts bar 格式（猜測）：
 *   每筆 40 bytes:
 *     date_serial  int32 LE  (天數，從 1899-12-30 或 2001-01-01)
 *     time_mins    int32 LE  (分鐘，0=day bar)
 *     open         double LE (8 bytes)
 *     high         double LE
 *     low          double LE
 *     close        double LE
 *     volume       int64 LE  (8 bytes)  ← 總 40 bytes
 */
function tryParseOhlcv(data) {
  const results = { format: null, bars: [] };

  // 嘗試 CSV 格式
  if (data[0] >= 0x30 && data[0] <= 0x39) {
    // starts with digit
    const text = data.toString("utf8");
    const lines = text
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 3);
    // MultiCharts CSV: "20230101,0900,41000,41500,40500,41200,12345"
    const csvRe = /^(\d{8}),(\d{4}),([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+),(\d+)/;
    if (csvRe.test(lines[0])) {
      results.format = "csv";
      const allLines = text.split("\n").filter((l) => l.trim());
      for (const line of allLines) {
        const m = csvRe.exec(line);
        if (!m) {
          continue;
        }
        const dateStr = m[1]; // YYYYMMDD
        const timeStr = m[2]; // HHMM
        results.bars.push({
          date: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
          time: `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`,
          open: Number.parseFloat(m[3]),
          high: Number.parseFloat(m[4]),
          low: Number.parseFloat(m[5]),
          close: Number.parseFloat(m[6]),
          volume: Number.parseInt(m[7], 10),
        });
      }
      return results;
    }
  }

  // 嘗試二進位 double 格式（40 bytes per bar）
  if (data.length % 40 === 0 && data.length >= 40) {
    const nBars = data.length / 40;
    // 驗證前幾筆看起來像合理的期貨價格
    let valid = 0;
    const testBars = Math.min(10, nBars);
    for (let i = 0; i < testBars; i++) {
      const off = i * 40;
      const date = data.readInt32LE(off);
      const time = data.readInt32LE(off + 4);
      const open = data.readDoubleLE(off + 8);
      if (
        date > 40000 &&
        date < 60000 &&
        time >= 0 &&
        time < 1440 &&
        open > 1000 &&
        open < 200000
      ) {
        valid++;
      }
    }
    if (valid >= testBars * 0.8) {
      results.format = "binary40";
      // 轉換日期：MultiCharts 從 1899-12-30 開始（Excel serial）
      const BASE = new Date(1899, 11, 30).getTime();
      for (let i = 0; i < nBars; i++) {
        const off = i * 40;
        const serial = data.readInt32LE(off);
        const mins = data.readInt32LE(off + 4);
        const open = data.readDoubleLE(off + 8);
        const high = data.readDoubleLE(off + 16);
        const low = data.readDoubleLE(off + 24);
        const close = data.readDoubleLE(off + 32);
        // volume 可能是 int32 在 offset 40-44，但 40 bytes 設計裡省略了
        const d = new Date(BASE + serial * 86400000);
        const yy = d.getFullYear(),
          mm = String(d.getMonth() + 1).padStart(2, "0"),
          dd = String(d.getDate()).padStart(2, "0");
        const hh = String(Math.floor(mins / 60)).padStart(2, "0"),
          mi = String(mins % 60).padStart(2, "0");
        results.bars.push({
          date: `${yy}-${mm}-${dd}`,
          time: `${hh}:${mi}`,
          open,
          high,
          low,
          close,
          volume: 0,
        });
      }
      return results;
    }
  }

  // 嘗試 48 bytes per bar (with volume as double)
  if (data.length % 48 === 0 && data.length >= 48) {
    const nBars = data.length / 48;
    let valid = 0;
    const testBars = Math.min(10, nBars);
    for (let i = 0; i < testBars; i++) {
      const off = i * 48;
      const date = data.readInt32LE(off);
      const open = data.readDoubleLE(off + 8);
      if (date > 40000 && date < 60000 && open > 1000 && open < 200000) {
        valid++;
      }
    }
    if (valid >= testBars * 0.8) {
      results.format = "binary48";
      const BASE = new Date(1899, 11, 30).getTime();
      for (let i = 0; i < nBars; i++) {
        const off = i * 48;
        const serial = data.readInt32LE(off);
        const mins = data.readInt32LE(off + 4);
        const open = data.readDoubleLE(off + 8);
        const high = data.readDoubleLE(off + 16);
        const low = data.readDoubleLE(off + 24);
        const close = data.readDoubleLE(off + 32);
        const volume = data.readDoubleLE(off + 40);
        const d = new Date(BASE + serial * 86400000);
        const yy = d.getFullYear(),
          mm = String(d.getMonth() + 1).padStart(2, "0"),
          dd = String(d.getDate()).padStart(2, "0");
        const hh = String(Math.floor(mins / 60)).padStart(2, "0"),
          mi = String(mins % 60).padStart(2, "0");
        results.bars.push({
          date: `${yy}-${mm}-${dd}`,
          time: `${hh}:${mi}`,
          open,
          high,
          low,
          close,
          volume: Math.round(volume),
        });
      }
      return results;
    }
  }

  // 嘗試 XML（含 bar 標籤）
  if (data[0] === 0x3c) {
    // '<'
    const text = data.toString("utf8", 0, Math.min(data.length, 4096));
    if (text.includes("<bar") || text.includes("<Bar") || text.includes("<record")) {
      results.format = "xml-bars";
      // 簡單 regex 解析
      const barRe =
        /<(?:bar|record)[^>]*date="(\d+)"[^>]*time="(\d+)"[^>]*open="([^"]+)"[^>]*high="([^"]+)"[^>]*low="([^"]+)"[^>]*close="([^"]+)"[^>]*/gi;
      let m2;
      const fullText = data.toString("utf8");
      while ((m2 = barRe.exec(fullText)) !== null) {
        const dateStr = m2[1],
          timeStr = m2[2];
        results.bars.push({
          date: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
          time: timeStr.length === 4 ? `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}` : timeStr,
          open: Number.parseFloat(m2[3]),
          high: Number.parseFloat(m2[4]),
          low: Number.parseFloat(m2[5]),
          close: Number.parseFloat(m2[6]),
          volume: 0,
        });
      }
      if (results.bars.length > 0) {
        return results;
      }
    }
  }

  results.format = "unknown";
  return results;
}

// ─── 主要提取函式 ─────────────────────────────────────────────────────────

async function loadSymbolCatalog(qmdPath) {
  const fd = fs.openSync(qmdPath, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024); // 8MB 讀頭部
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const header = buf.slice(0, n);

  // 找第一個 zlib 區塊
  for (let i = 0; i < Math.min(header.length - 2, 10000); i++) {
    if (
      header[i] === 0x78 &&
      (header[i + 1] === 0x9c || header[i + 1] === 0xda || header[i + 1] === 0x01)
    ) {
      const decompressed = await tryDecompress(header.slice(i));
      if (decompressed && decompressed[0] === 0x3c) {
        // '<' = XML
        const xmlText = decompressed.toString("utf8");
        const symbols = parseSymbolXml(xmlText);
        return { offset: i, symbols, xmlText };
      }
    }
  }
  return null;
}

async function extractSymbolData(qmdPath, symbolIds, outDir, opts = {}) {
  const { verbose = false, maxBars = Infinity } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  // 載入商品目錄
  console.log("載入商品目錄...");
  const catalog = await loadSymbolCatalog(qmdPath);
  if (!catalog) {
    console.error("無法解析商品目錄");
    return [];
  }

  const targetSymbols = symbolIds
    ? catalog.symbols.filter((s) =>
        symbolIds.some(
          (id) => s.symbolRoot === id || s.symbolName === id || s.symbolName.startsWith(id),
        ),
      )
    : catalog.symbols.filter((s) => s.expired === 247 || s.expired < 10);

  console.log(`商品目錄: ${catalog.symbols.length} 個商品，目標: ${targetSymbols.length} 個`);
  if (verbose) {
    targetSymbols.forEach((s) => console.log(`  ${s.symbolName} (id=${s.id})`));
  }

  // 掃描所有 zlib 區塊
  const allBlocks = await scanAllZlibBlocks(qmdPath);
  console.log(`總共 ${allBlocks.length} 個 zlib 區塊`);

  // 跳過第一個（商品目錄 XML）
  const dataBlocks = allBlocks.slice(1);

  // 嘗試解壓縮每個資料區塊並識別商品
  const fileSize = fs.statSync(qmdPath).size;
  const fd = fs.openSync(qmdPath, "r");

  const results = [];
  let processed = 0;

  // 對於每個 zlib 區塊，嘗試解壓並解析 OHLCV
  // 策略：每個區塊前面可能有一個商品 ID
  for (let bi = 0; bi < Math.min(dataBlocks.length, 2000); bi++) {
    const blockOff = dataBlocks[bi];
    const nextOff = bi + 1 < dataBlocks.length ? dataBlocks[bi + 1] : fileSize;
    const blockSize = Math.min(nextOff - blockOff, 32 * 1024 * 1024);

    if (blockSize < 10) {
      continue;
    }

    const buf = Buffer.alloc(blockSize);
    fs.readSync(fd, buf, 0, blockSize, blockOff);

    // 讀取區塊前 8 字節（可能是元數據）
    // 查看此區塊前方是否有商品ID的線索
    const preBuf = Buffer.alloc(32);
    if (blockOff >= 32) {
      fs.readSync(fd, preBuf, 0, 32, blockOff - 32);
    }
    const preInts = [];
    for (let i = 0; i < 8; i++) {
      preInts.push(preBuf.readInt32LE(i * 4));
    }

    const decompressed = await tryDecompress(buf);
    if (!decompressed || decompressed.length < 40) {
      continue;
    }

    const parsed = tryParseOhlcv(decompressed);
    if (parsed.bars.length > 0) {
      processed++;
      const firstBar = parsed.bars[0];
      const lastBar = parsed.bars[parsed.bars.length - 1];

      // 識別商品（從前面的整數找 symbolId）
      let matchedSym = null;
      for (const pre of preInts) {
        const sym = catalog.symbols.find((s) => s.id === pre);
        if (sym) {
          matchedSym = sym;
          break;
        }
      }

      if (verbose || processed <= 20) {
        console.log(
          `[block ${bi}@${blockOff}] fmt=${parsed.format} bars=${parsed.bars.length} ` +
            `date=${firstBar.date}~${lastBar.date} close=${lastBar.close} ` +
            `sym=${matchedSym?.symbolName || "?"}  preInts=[${preInts.join(",")}]`,
        );
      }

      if (matchedSym) {
        const outFile = path.join(outDir, `${matchedSym.symbolName}-1min-bars.jsonl`);
        const lines = parsed.bars
          .slice(0, maxBars)
          .map((b) => JSON.stringify({ ...b, symbol: matchedSym.symbolName }));
        fs.appendFileSync(outFile, lines.join("\n") + "\n", "utf8");
        results.push({ symbol: matchedSym.symbolName, bars: parsed.bars.length, file: outFile });
      }
    }

    if (bi % 100 === 0) {
      process.stdout.write(`  block ${bi}/${dataBlocks.length}\r`);
    }
  }

  fs.closeSync(fd);
  console.log(`\n提取完成: ${processed} 個有效資料塊`);
  return results;
}

// ─── 主函式 ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  function flag(name) {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  }
  const hasFlag = (n) => args.includes(n);

  const qmdPath = flag("--qmd") || DEFAULT_DOMESTIC_QMD;
  const outDir = flag("--out-dir") || path.join("D:", "OpenClaw", ".openclaw", "bars", "qmd");

  console.log(`QMD: ${qmdPath}`);
  console.log(`輸出目錄: ${outDir}`);

  if (!fs.existsSync(qmdPath)) {
    console.error(`❌ 檔案不存在: ${qmdPath}`);
    process.exit(1);
  }

  if (hasFlag("--list") || args.length === 0) {
    // 列出商品目錄
    const catalog = await loadSymbolCatalog(qmdPath);
    if (!catalog) {
      console.error("無法解析商品目錄");
      process.exit(1);
    }
    console.log(`\n商品目錄（${catalog.symbols.length} 個）:`);
    // 分類顯示
    const cats = {
      futures: catalog.symbols.filter((s) => s.category === 0 && !s.symbolName.includes("_")),
      indices: catalog.symbols.filter((s) => s.category === 4),
      sessions: catalog.symbols.filter((s) => s.symbolName.includes("_")),
    };
    console.log(`\n── 期貨 (${cats.futures.length}) ──`);
    cats.futures
      .slice(0, 50)
      .forEach((s) =>
        console.log(
          `  ${s.symbolName.padEnd(12)} root=${s.symbolRoot.padEnd(6)} expired=${s.expired}`,
        ),
      );
    console.log(`\n── 指數 (${cats.indices.length}) ──`);
    cats.indices
      .slice(0, 20)
      .forEach((s) =>
        console.log(`  ${s.symbolName.padEnd(12)} desc=${s.description.slice(0, 30)}`),
      );
    return;
  }

  if (hasFlag("--probe")) {
    // 探針模式：分析前 50 個資料區塊的格式
    const catalog = await loadSymbolCatalog(qmdPath);
    const allBlocks = await scanAllZlibBlocks(qmdPath);
    const fd = fs.openSync(qmdPath, "r");
    const fileSize = fs.statSync(qmdPath).size;

    console.log(`\n前 50 個資料區塊分析：`);
    for (let bi = 1; bi < Math.min(allBlocks.length, 51); bi++) {
      const off = allBlocks[bi];
      const nextOff = bi + 1 < allBlocks.length ? allBlocks[bi + 1] : fileSize;
      const size = Math.min(nextOff - off, 8 * 1024 * 1024);

      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, off);

      const decompressed = await tryDecompress(buf);
      if (!decompressed) {
        console.log(`  [${bi}@${off}] ❌ 無法解壓`);
        continue;
      }

      // 前 32 bytes hex
      const first32 = decompressed.slice(0, 32);
      const hex = Array.from(first32, (b) => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = Array.from(first32, (b) =>
        b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
      ).join("");

      // 讀取此區塊前方 16 bytes
      const pre = Buffer.alloc(16);
      if (off >= 16) {
        fs.readSync(fd, pre, 0, 16, off - 16);
      }
      const preHex = [...pre].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const preInts = [
        pre.readInt32LE(0),
        pre.readInt32LE(4),
        pre.readInt32LE(8),
        pre.readInt32LE(12),
      ];

      const parsed = tryParseOhlcv(decompressed);
      const sym = catalog?.symbols.find((s) => preInts.some((id) => s.id === id));

      console.log(
        `  [${bi}@${off}] decompSize=${decompressed.length} fmt=${parsed.format} bars=${parsed.bars.length}`,
      );
      console.log(
        `    pre: ${preHex} → ints=[${preInts.join(",")}] → sym=${sym?.symbolName || "?"}`,
      );
      console.log(`    data[0..32]: ${hex}`);
      console.log(`    ascii: ${ascii}`);
      if (parsed.bars.length > 0) {
        const b = parsed.bars[0];
        console.log(
          `    first bar: date=${b.date} time=${b.time} O=${b.open} H=${b.high} L=${b.low} C=${b.close}`,
        );
      }
    }
    fs.closeSync(fd);
    return;
  }

  if (hasFlag("--extract")) {
    const symbolArg = flag("--symbol");
    const symbols = symbolArg ? symbolArg.split(",") : null;
    const results = await extractSymbolData(qmdPath, symbols, outDir, { verbose: true });
    console.log(`\n提取結果:`);
    results.forEach((r) => console.log(`  ${r.symbol}: ${r.bars} bars → ${r.file}`));
    return;
  }

  // 預設：--probe
  const catalog = await loadSymbolCatalog(qmdPath);
  if (catalog) {
    console.log(`\n✅ 商品目錄解析成功: ${catalog.symbols.length} 個商品`);
    console.log(`使用 --list 查看商品清單`);
    console.log(`使用 --probe 分析資料區塊格式`);
    console.log(`使用 --extract --symbol TXF 提取台指期資料`);
  }
}

export { loadSymbolCatalog, scanAllZlibBlocks, extractSymbolData, tryParseOhlcv };

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
