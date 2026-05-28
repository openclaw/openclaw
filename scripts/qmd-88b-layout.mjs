/**
 * qmd-88b-layout.mjs — 88-byte record 레이아웃 완전 해석
 * FILETIME(+80)이 실제 bar 타임스탬프인지 확인
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const QMD =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

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

function filetime2Date(bigInt) {
  // Windows FILETIME: 100-nanosecond intervals since 1601-01-01
  const EPOCH_DIFF = 116444736000000000n;
  if (bigInt < EPOCH_DIFF) return null;
  const ms = Number((bigInt - EPOCH_DIFF) / 10000n);
  if (ms > 2e12) return null;
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function oleSerial2Date(s) {
  if (s < 30000 || s > 60000) return `??(${s})`;
  const d = new Date(Date.UTC(1899, 11, 30) + s * 86400000);
  return d.toISOString().slice(0, 10);
}

// Block4 첫 20개 88-byte record 완전 해석
const data = await loadBlock(29535071);
console.log(`Block4: ${data.length} bytes = header(8) + ${(data.length - 8) / 88} recs × 88B`);
console.log(`\n88-byte 레이아웃 가정:`);
console.log(`  +0..+7:   open (double)`);
console.log(`  +8..+15:  high (double)`);
console.log(`  +16..+23: low  (double)`);
console.log(`  +24..+31: close (double)`);
console.log(`  +32..+39: volume (int64)`);
console.log(`  +40..+43: field_A (int32) [OLE date?]`);
console.log(`  +44..+47: field_B (int32) [time?]`);
console.log(`  +48..+55: field_C (int64) [count?]`);
console.log(`  +56..+59: field_D (int32)`);
console.log(`  +60..+63: field_E (int32)`);
console.log(`  +64..+67: field_F (int32)`);
console.log(`  +68..+71: field_G (int32)`);
console.log(`  +72..+79: field_H (int64) [zeros?]`);
console.log(`  +80..+87: field_I (uint64) [FILETIME?]`);

console.log(`\n=== 첫 20개 bar 데이터 ===`);
const HEADER = 8;
const REC = 88;
for (let i = 0; i < 20; i++) {
  const base = HEADER + i * REC;
  const o = data.readDoubleLE(base + 0);
  const h = data.readDoubleLE(base + 8);
  const l = data.readDoubleLE(base + 16);
  const c = data.readDoubleLE(base + 24);
  const vol = Number(data.readBigInt64LE(base + 32));
  const fA = data.readInt32LE(base + 40);
  const fB = data.readInt32LE(base + 44);
  const fC = data.readBigInt64LE(base + 48);
  const fD = data.readInt32LE(base + 56);
  const fE = data.readInt32LE(base + 60);
  const fF = data.readInt32LE(base + 64);
  const fG = data.readInt32LE(base + 68);
  const fI = data.readBigUInt64LE(base + 80);

  const fIDate = filetime2Date(fI);
  const oleA = oleSerial2Date(fA);

  // OHLC 유효성 확인
  const validOHLC =
    o > 5000 &&
    o < 100000 &&
    h >= Math.max(o, c) * 0.998 &&
    h <= Math.max(o, c) * 1.002 &&
    l <= Math.min(o, c) * 1.002 &&
    l >= Math.min(o, c) * 0.998;

  if (validOHLC) {
    console.log(
      `  [${i}] O=${o.toFixed(2)} H=${h.toFixed(2)} L=${l.toFixed(2)} C=${c.toFixed(2)} V=${vol}`,
    );
    console.log(`       fA=${fA}(${oleA}) fB=${fB} fC=${fC} fD=${fD} fE=${fE} fF=${fF} fG=${fG}`);
    console.log(`       FILETIME(+80)=${fIDate || `raw:0x${fI.toString(16)}`}`);
  } else {
    const hex = [...data.slice(base, base + 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      `  [${i}] *** NOT VALID OHLC *** fA=${fA}(${oleA}) FILETIME=${fIDate || "?"} hex:${hex}...`,
    );
  }
}

// 연속된 바의 FILETIME 차이 계산 (인접한 valid bar들)
console.log(`\n=== FILETIME 간격 분석 ===`);
const filetimes = [];
for (let i = 0; i < Math.min(100, (data.length - HEADER) / REC); i++) {
  const base = HEADER + i * REC;
  const o = data.readDoubleLE(base);
  const c = data.readDoubleLE(base + 24);
  if (o > 5000 && o < 100000 && c > 5000 && c < 100000) {
    const ft = data.readBigUInt64LE(base + 80);
    const ftDate = filetime2Date(ft);
    if (ftDate) filetimes.push({ i, ftDate, ft });
  }
}
console.log(`  Valid FILETIME bars in first 100: ${filetimes.length}`);
for (let i = 0; i < Math.min(filetimes.length, 10); i++) {
  const { i: idx, ftDate } = filetimes[i];
  let diffMin = "";
  if (i > 0) {
    const diffMs = Number(filetimes[i].ft - filetimes[i - 1].ft) / 10000;
    diffMin = `(+${Math.round(diffMs / 60000)}min)`;
  }
  console.log(`  bar[${idx}]: ${ftDate} ${diffMin}`);
}
