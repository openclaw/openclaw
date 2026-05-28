/**
 * qmd-bars-probe.mjs
 * 根據索引表讀取實際 K 棒資料塊
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const gunzip = promisify(zlib.gunzip);

const QMD_PATH =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

// 從之前分析知道的索引
const INDEX_ENTRIES = [
  { seq: 0, fileOffset: 1560 }, // XML catalog header area
  { seq: 1, fileOffset: 4087 }, // 第一個資料塊（前 8 bytes 是 block header）
  { seq: 2, fileOffset: 28912012 },
  { seq: 3, fileOffset: 29030277 },
  { seq: 4, fileOffset: 29535071 },
  { seq: 5, fileOffset: 30030206 },
  { seq: 6, fileOffset: 30038467 },
  { seq: 7, fileOffset: 30046728 },
  { seq: 8, fileOffset: 30172359 },
  { seq: 9, fileOffset: 30177556 },
  { seq: 10, fileOffset: 49548493 },
  { seq: 11, fileOffset: 49677761 },
  { seq: 12, fileOffset: 74707051 },
  { seq: 13, fileOffset: 74841585 },
  { seq: 14, fileOffset: 120143577 },
  { seq: 15, fileOffset: 120274238 },
  { seq: 16, fileOffset: 167703725 },
  { seq: 17, fileOffset: 167849265 },
  { seq: 18, fileOffset: 187804783 },
  { seq: 19, fileOffset: 187804842 },
  { seq: 20, fileOffset: 187804881 },
  { seq: 21, fileOffset: 187858180 },
  { seq: 22, fileOffset: 192283527 },
  { seq: 23, fileOffset: 192326184 },
  { seq: 24, fileOffset: 221610035 },
  { seq: 25, fileOffset: 221664394 },
  { seq: 26, fileOffset: 225882234 },
  { seq: 27, fileOffset: 225918816 },
  { seq: 28, fileOffset: 228195028 },
  { seq: 29, fileOffset: 228209809 },
  { seq: 30, fileOffset: 235435029 },
  { seq: 31, fileOffset: 235435089 },
  { seq: 32, fileOffset: 235462502 },
  { seq: 33, fileOffset: 236637795 },
  { seq: 34, fileOffset: 236662342 },
  { seq: 35, fileOffset: 238137975 },
  { seq: 36, fileOffset: 238156921 },
  { seq: 37, fileOffset: 238410895 }, // last entry
];

const FILE_SIZE = fs.statSync(QMD_PATH).size;

async function tryDecomp(buf) {
  try {
    return await inflate(buf);
  } catch {}
  try {
    return await inflateRaw(buf);
  } catch {}
  try {
    return await gunzip(buf);
  } catch {}
  return null;
}

function readBlock(fd, offset, size) {
  const buf = Buffer.alloc(size);
  const n = fs.readSync(fd, buf, 0, size, offset);
  return buf.slice(0, n);
}

async function probeBlock(fd, entry, nextEntry) {
  const { seq, fileOffset } = entry;
  const nextOffset = nextEntry ? nextEntry.fileOffset : FILE_SIZE;

  // 讀 8 bytes 的 block header
  const header8 = readBlock(fd, fileOffset, 8);
  const h0 = header8.readUInt32LE(0);
  const h1 = header8.readUInt32LE(4);
  console.log(`\n[seq ${seq} @${fileOffset}] header: LE32=[${h0}, ${h1}]`);

  // 嘗試在 fileOffset+8 讀取 zlib 資料
  const dataOffset = fileOffset + 8;
  const maxSize = Math.min(nextOffset - dataOffset, 64 * 1024 * 1024);
  if (maxSize <= 0) {
    console.log(`  ⚠️ 空塊`);
    return null;
  }

  const buf = readBlock(fd, dataOffset, maxSize);
  const first4 = Array.from(buf.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`  data[0..4]: ${first4}`);

  const decompressed = await tryDecomp(buf);
  if (!decompressed) {
    // 嘗試不跳過 8 bytes
    const buf2 = readBlock(fd, fileOffset, Math.min(nextOffset - fileOffset, 64 * 1024 * 1024));
    const first4b = Array.from(buf2.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`  (no-skip) data[0..4]: ${first4b}`);
    const dec2 = await tryDecomp(buf2);
    if (dec2) {
      console.log(`  ✅ decompressed without skip: ${dec2.length} bytes`);
      return analyzeBarData(dec2);
    }
    console.log(`  ❌ cannot decompress`);
    return null;
  }

  console.log(`  ✅ decompressed: ${decompressed.length} bytes`);
  return analyzeBarData(decompressed);
}

function analyzeBarData(data) {
  // 嘗試 CSV 格式
  const first = data[0];
  if (first >= 0x30 && first <= 0x39) {
    // 數字開頭 → CSV
    const text = data.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const sample = lines.slice(0, 5);
    console.log(`  格式: CSV (${lines.length} 行)`);
    sample.forEach((l, i) => console.log(`    [${i}]: ${l.slice(0, 100)}`));
    return { format: "csv", lines };
  }

  // 嘗試 XML
  if (first === 0x3c) {
    // '<'
    const text = data.toString("utf8", 0, Math.min(500, data.length));
    console.log(`  格式: XML\n  ${text.slice(0, 300)}`);
    return { format: "xml", text };
  }

  // 嘗試 JSON
  if (first === 0x7b || first === 0x5b) {
    // '{' or '['
    const text = data.toString("utf8", 0, 200);
    console.log(`  格式: JSON\n  ${text}`);
    return { format: "json" };
  }

  // 二進位格式分析
  console.log(`  格式: binary (${data.length} bytes)`);
  const first32 = data.slice(0, 32);
  const hex = Array.from(first32, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const asc = Array.from(first32, (b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
  ).join("");
  console.log(`  hex[0..32]: ${hex}`);
  console.log(`  asc[0..32]: ${asc}`);

  // 嘗試各種固定長度結構
  for (const recLen of [16, 24, 28, 32, 36, 40, 44, 48, 56, 64]) {
    if (data.length % recLen === 0) {
      const nRecs = data.length / recLen;
      if (nRecs >= 10 && nRecs <= 5_000_000) {
        // 驗證前幾筆：看是否像 OHLCV
        let score = 0;
        for (let i = 0; i < Math.min(10, nRecs); i++) {
          const off = i * recLen;
          // 嘗試 double × 4
          if (recLen >= 32) {
            const d1 = data.readDoubleLE(off);
            const d2 = data.readDoubleLE(off + 8);
            // 台灣期貨價格範圍 5000~100000, 海外 500~50000
            if (d1 > 1000 && d1 < 200000 && d2 >= d1 * 0.9 && d2 <= d1 * 1.1) {
              score++;
            }
          }
          // 嘗試 int32 × 4 for 日期/時間+整數價格
          const i0 = data.readInt32LE(off);
          // 日期格式 YYYYMMDD 或 serial number (40000-60000)
          if ((i0 >= 20100101 && i0 <= 20261231) || (i0 >= 40000 && i0 <= 60000)) {
            score += 2;
          }
        }
        if (score >= 5) {
          console.log(`  ★ 可能是 ${recLen}-byte 記錄 (${nRecs} 筆, score=${score})`);
          // 顯示前 3 筆
          for (let i = 0; i < Math.min(3, nRecs); i++) {
            const off = i * recLen;
            const ints = [];
            const doubles = [];
            for (let j = 0; j < recLen; j += 4) {
              ints.push(data.readInt32LE(off + j));
            }
            if (recLen >= 32) {
              for (let j = 0; j < recLen; j += 8) {
                doubles.push(data.readDoubleLE(off + j).toFixed(2));
              }
            }
            console.log(`    rec[${i}] ints=[${ints.join(",")}] doubles=[${doubles.join(",")}]`);
          }
        }
      }
    }
  }

  return { format: "binary", size: data.length };
}

async function main() {
  const fd = fs.openSync(QMD_PATH, "r");

  // 先確認 XML 塊的結構
  console.log(`\n═══ 驗證 XML 塊 @1548 ═══`);
  const before1568 = readBlock(fd, 1548, 32);
  const hex = Array.from(before1568, (b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`1548..1580: ${hex}`);
  for (let i = 0; i < 5; i++) {
    const v = before1568.readUInt32LE(i * 4);
    console.log(`  offset ${1548 + i * 4}: LE32=${v}`);
  }

  // 讀前 10 個 data block
  console.log(`\n═══ 前 10 個資料塊分析 ═══`);
  for (let i = 1; i <= Math.min(10, INDEX_ENTRIES.length - 1); i++) {
    await probeBlock(fd, INDEX_ENTRIES[i], INDEX_ENTRIES[i + 1]);
  }

  fs.closeSync(fd);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
