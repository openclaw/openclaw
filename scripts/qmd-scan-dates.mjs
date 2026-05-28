/**
 * qmd-scan-dates.mjs — block4의 처음 4096바이트에서 OLE date int32 스캔
 * → 실제 bar 구조 파악
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const QMD =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

function oleSerial2Date(s) {
  const d = new Date(Date.UTC(1899, 11, 30) + s * 86400000);
  return d.toISOString().slice(0, 10);
}

async function loadBlock(offset) {
  const fd = fs.openSync(QMD, "r");
  const hdr = Buffer.alloc(8);
  fs.readSync(fd, hdr, 0, 8, offset);
  const compSize = hdr.readUInt32LE(4);
  const buf = Buffer.alloc(Math.min(compSize, 64 * 1024 * 1024));
  fs.readSync(fd, buf, 0, buf.length, offset + 8);
  fs.closeSync(fd);
  return await inflate(buf);
}

// Block4 첫 4096B: 모든 OLE date 위치 스캔
const data = await loadBlock(29535071);
console.log(`Block4 decompressed: ${data.length} bytes`);

console.log("\n=== OLE date int32 scan (first 4096B) ===");
for (let i = 0; i + 3 < Math.min(data.length, 4096); i += 4) {
  const v = data.readInt32LE(i);
  if (v >= 43000 && v <= 47000) {
    // 주변 컨텍스트: 앞 32B의 double 값
    const prevDbls = [];
    for (let j = Math.max(0, i - 32); j + 7 < i; j += 8) {
      const d2 = data.readDoubleLE(j);
      if (d2 > 5000 && d2 < 100000) prevDbls.push(`@${j}:${d2.toFixed(2)}`);
    }
    const nextInt = i + 4 < data.length ? data.readInt32LE(i + 4) : "?";
    console.log(
      `  offset ${String(i).padStart(5)}: OLE=${v} (${oleSerial2Date(v)}) next_int32=${nextInt} prev_prices=[${prevDbls.join(", ")}]`,
    );
  }
}

// Block4: 특정 offset에서 FILETIME 스캔
console.log("\n=== FILETIME scan (first 4096B, Windows FILETIME 2020-2025 range) ===");
const FT_MIN = 132200000000000000n; // 2020-01-01
const FT_MAX = 133500000000000000n; // 2025-01-01
for (let i = 0; i + 7 < Math.min(data.length, 4096); i += 8) {
  const v = data.readBigUInt64LE(i);
  if (v >= FT_MIN && v <= FT_MAX) {
    const ms = Number((v - 116444736000000000n) / 10000n);
    const dt = new Date(ms);
    console.log(
      `  offset ${String(i).padStart(5)}: FILETIME=${v} = ${dt.toISOString().slice(0, 19)}`,
    );
  }
}

// Block2도 동일하게 분석
console.log("\n=== Block2 OLE date scan (first 2048B) ===");
const b2 = await loadBlock(28912012);
for (let i = 0; i + 3 < Math.min(b2.length, 2048); i += 4) {
  const v = b2.readInt32LE(i);
  if (v >= 43000 && v <= 47000) {
    const prevDbls = [];
    for (let j = Math.max(0, i - 32); j + 7 < i; j += 8) {
      const d2 = b2.readDoubleLE(j);
      if (d2 > 5000 && d2 < 100000) prevDbls.push(`@${j}:${d2.toFixed(2)}`);
    }
    console.log(
      `  B2 offset ${String(i).padStart(5)}: OLE=${v} (${oleSerial2Date(v)}) prev=[${prevDbls.join(", ")}]`,
    );
  }
}

console.log("\n=== Block2 FILETIME scan (first 2048B) ===");
for (let i = 0; i + 7 < Math.min(b2.length, 2048); i += 8) {
  const v = b2.readBigUInt64LE(i);
  if (v >= FT_MIN && v <= FT_MAX) {
    const ms = Number((v - 116444736000000000n) / 10000n);
    const dt = new Date(ms);
    console.log(
      `  B2 offset ${String(i).padStart(5)}: FILETIME = ${dt.toISOString().slice(0, 19)}`,
    );
  }
}
