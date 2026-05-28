/**
 * probe-qmd-format.mjs
 *
 * 探針：分析群益 MultiCharts QMD 歷史資料包的二進位格式
 * 嘗試 zlib 解壓縮並識別 OHLCV 記錄結構
 *
 * 用法：node scripts/probe-qmd-format.mjs [qmd-path]
 */

import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflateRaw = promisify(zlib.inflateRaw);
const inflate = promisify(zlib.inflate);

// 預設使用較小的 238MB 檔案（國內三年）
const DEFAULT_QMD = path.join(
  "D:",
  "群益及元大API",
  "群益國內三年歷史資料包x64_202508",
  "國內三年歷史資料包",
  "群益MC12x64內期歷史資料包_20241212.qmd",
);

function hexDump(buf, offset, len = 64, label = "") {
  const slice = buf.slice(offset, offset + len);
  const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = Array.from(slice, (b) =>
    b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
  ).join("");
  console.log(`[${label || "offset " + offset}]`);
  console.log(`  HEX:   ${hex}`);
  console.log(`  ASCII: ${ascii}`);
}

async function scanForZlib(buf, maxScan = 10000) {
  const offsets = [];
  for (let i = 0; i < Math.min(buf.length - 2, maxScan); i++) {
    const b0 = buf[i],
      b1 = buf[i + 1];
    // zlib header patterns: 0x789C (default), 0x7801 (no compress), 0x78DA (best), 0x785E
    if (b0 === 0x78 && (b1 === 0x9c || b1 === 0x01 || b1 === 0xda || b1 === 0x5e)) {
      offsets.push(i);
    }
    // gzip: 0x1F 0x8B
    if (b0 === 0x1f && b1 === 0x8b) {
      offsets.push({ offset: i, type: "gzip" });
    }
  }
  return offsets;
}

async function analyzeDecompressed(data) {
  console.log(`\n── 分析解壓縮資料 (${data.length} bytes) ──`);
  hexDump(data, 0, 128, "header");

  // 嘗試找出文字內容
  const text = data.toString("utf8", 0, Math.min(2048, data.length));
  const printable = text.replace(/[^\x20-\x7e\n\r\t一-鿿]/g, ".");
  console.log(`\n文字預覽（前 512 字）:\n${printable.slice(0, 512)}`);

  // 嘗試作為 JSON
  try {
    const j = JSON.parse(data.toString("utf8"));
    console.log("✅ 解壓後為 JSON:", typeof j, Array.isArray(j) ? `array[${j.length}]` : "");
    return { format: "json", data: j };
  } catch {}

  // 嘗試作為 CSV/TSV
  if (text.includes(",") || text.includes("\t")) {
    const lines = text
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 5);
    console.log("可能是 CSV/TSV，前 5 行:");
    lines.forEach((l, i) => console.log(`  [${i}] ${l.slice(0, 120)}`));
    return { format: "csv", data: text };
  }

  // 嘗試固定長度二進位記錄（OHLCV 典型結構）
  // 猜測格式：date(4B) + time(4B) + open(8B double) + high(8B) + low(8B) + close(8B) + volume(8B) = 40 bytes
  // 或：date(4B) + time(4B) + open(4B int) + high(4B) + low(4B) + close(4B) + volume(4B) = 28 bytes
  for (const recLen of [28, 32, 36, 40, 44, 48, 56, 64, 80]) {
    if (data.length % recLen === 0) {
      const nRecs = data.length / recLen;
      if (nRecs > 10 && nRecs < 10_000_000) {
        console.log(`\n可能的固定記錄長度 = ${recLen} bytes → ${nRecs} 筆記錄`);
        // 讀取前 3 筆
        for (let i = 0; i < Math.min(3, nRecs); i++) {
          const off = i * recLen;
          const slice = data.slice(off, off + recLen);
          const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
          // 嘗試解讀為 double (little-endian)
          const doubles = [];
          for (let d = 0; d + 8 <= recLen; d += 8) {
            doubles.push(
              slice.readDoubleBE(d).toFixed(2) +
                "(BE)/" +
                slice.readDoubleLE(d).toFixed(2) +
                "(LE)",
            );
          }
          const ints = [];
          for (let d = 0; d + 4 <= recLen; d += 4) {
            ints.push(slice.readInt32LE(d));
          }
          console.log(`  rec[${i}]: hex=${hex.slice(0, 48)}...`);
          console.log(`         doubles: ${doubles.slice(0, 5).join(", ")}`);
          console.log(`         ints:    ${ints.slice(0, 7).join(", ")}`);
        }
      }
    }
  }

  // 二進位中搜尋可讀字串（股票代號、日期等）
  const strings = [];
  let cur = "";
  for (let i = 0; i < Math.min(data.length, 50000); i++) {
    const c = data[i];
    if (c >= 0x20 && c < 0x7f) {
      cur += String.fromCharCode(c);
    } else {
      if (cur.length >= 4) {
        strings.push({ offset: i - cur.length, str: cur });
      }
      cur = "";
    }
  }
  if (cur.length >= 4) {
    strings.push({ offset: data.length - cur.length, str: cur });
  }

  console.log(`\n可讀字串（前 30 個）:`);
  strings.slice(0, 30).forEach((s) => console.log(`  @${s.offset}: "${s.str}"`));

  return { format: "binary", strings };
}

async function main() {
  const qmdPath = process.argv[2] || DEFAULT_QMD;
  console.log(`\n═══ QMD 格式探針 ═══`);
  console.log(`檔案: ${qmdPath}`);

  if (!fs.existsSync(qmdPath)) {
    console.error(`❌ 檔案不存在: ${qmdPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(qmdPath);
  console.log(`大小: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  // 只讀前 64KB 做結構分析（加快速度）
  const fd = fs.openSync(qmdPath, "r");
  const headerBuf = Buffer.alloc(65536);
  const bytesRead = fs.readSync(fd, headerBuf, 0, 65536, 0);
  fs.closeSync(fd);
  const header = headerBuf.slice(0, bytesRead);

  console.log(`\n── 檔頭分析 ──`);
  hexDump(header, 0, 32, "magic+version");

  // 讀 magic
  const magic = header.slice(0, 4).toString("ascii").replaceAll(String.fromCharCode(0), ".");
  console.log(
    `Magic: "${magic}" (hex: ${Array.from(header.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ")})`,
  );

  // 讀整數欄位
  if (header.length >= 16) {
    for (let i = 4; i < Math.min(32, header.length); i += 4) {
      const v_le = header.readUInt32LE(i);
      const v_be = header.readUInt32BE(i);
      console.log(`  offset ${i}: LE=${v_le}  BE=${v_be}`);
    }
  }

  // 掃描 zlib 魔術字節
  console.log(`\n── 掃描 zlib/gzip 起點（前 64KB）──`);
  const zlibOffsets = await scanForZlib(header);
  console.log(`找到 ${zlibOffsets.length} 個可能的壓縮區塊:`, zlibOffsets.slice(0, 10));

  // 嘗試解壓縮每個找到的 zlib 位置
  let bestResult = null;
  for (const offInfo of zlibOffsets.slice(0, 5)) {
    const off = typeof offInfo === "number" ? offInfo : offInfo.offset;
    const label = `zlib@${off}`;
    console.log(`\n── 嘗試解壓縮 ${label} ──`);

    // 使用完整檔案的該偏移位置
    const fd2 = fs.openSync(qmdPath, "r");
    const chunkSize = Math.min(stat.size - off, 8 * 1024 * 1024); // 最多讀 8MB
    const chunkBuf = Buffer.alloc(chunkSize);
    fs.readSync(fd2, chunkBuf, 0, chunkSize, off);
    fs.closeSync(fd2);

    const methods = [
      { name: "inflate", fn: inflate },
      { name: "inflateRaw", fn: inflateRaw },
    ];
    for (const m of methods) {
      try {
        const out = await m.fn(chunkBuf);
        console.log(
          `✅ ${label} ${m.name} 成功! 解壓後 = ${out.length} bytes (${(out.length / 1024 / 1024).toFixed(1)} MB)`,
        );
        const result = await analyzeDecompressed(out);
        if (!bestResult) {
          bestResult = { offset: off, method: m.name, size: out.length, result };
        }
        break;
      } catch (e) {
        console.log(`  ${m.name}: ${e.message.slice(0, 60)}`);
      }
    }
  }

  if (bestResult) {
    console.log(`\n══ 最佳解壓縮結果 ══`);
    console.log(`offset=${bestResult.offset} method=${bestResult.method} size=${bestResult.size}`);
    console.log(`format=${bestResult.result?.format}`);
    if (bestResult.result?.format === "csv") {
      const lines = bestResult.result.data
        .split("\n")
        .filter((l) => l.trim())
        .slice(0, 10);
      console.log("前 10 行:");
      lines.forEach((l, i) => console.log(`  [${i}] ${l}`));
    }
  } else {
    console.log(`\n❌ 無法解壓縮任何區塊`);
    console.log(`\n── 替代分析：直接二進位掃描 ──`);
    await analyzeDecompressed(header);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
