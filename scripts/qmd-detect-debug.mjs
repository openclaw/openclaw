/**
 * qmd-detect-debug.mjs — 偵錯 detectAndParseRecords 的評分邏輯
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
  const decompSize = hdr.readUInt32LE(0);
  console.log(`  hdr: decompSize=${decompSize}, compSize=${compSize}`);
  const buf = Buffer.alloc(Math.min(compSize, 64 * 1024 * 1024));
  fs.readSync(fd, buf, 0, buf.length, offset + 8);
  fs.closeSync(fd);
  return await inflate(buf);
}

const CFGS = [
  [48, 8, 0, 32, 40, "48B+h8+date  (★block4確認)"],
  [40, 8, 0, 32, -1, "40B+h8+nodate(★block2/3確認)"],
  [40, 0, 0, 32, -1, "40B+h0+nodate"],
  [88, 0, 8, 40, 48, "88B+h0+date  (誤判格式)"],
  [64, 8, 0, 32, 40, "64B+h8+date"],
  [64, 8, 0, 32, -1, "64B+h8+nodate"],
];

async function testBlock(name, offset) {
  console.log(`\n══ ${name} @${offset} ══`);
  const data = await loadBlock(offset);
  console.log(`  decompressed: ${data.length} bytes`);

  for (const [recSize, headerSize, ohlcOff, volOff, dateOff, label] of CFGS) {
    const dataLen = data.length - headerSize;
    if (dataLen <= 0 || dataLen % recSize !== 0) continue;
    const nRecs = dataLen / recSize;
    if (nRecs < 3 || nRecs > 5_000_000) continue;

    let ohlcValid = 0,
      dateValid = 0,
      dateSeqOk = 0,
      prevDate = 0;
    const N = Math.min(20, nRecs);
    for (let ri = 0; ri < N; ri++) {
      const base = headerSize + ri * recSize;
      if (base + ohlcOff + 32 > data.length) continue;
      const o = data.readDoubleLE(base + ohlcOff);
      const h = data.readDoubleLE(base + ohlcOff + 8);
      const l = data.readDoubleLE(base + ohlcOff + 16);
      const c = data.readDoubleLE(base + ohlcOff + 24);
      if (
        o > 100 &&
        o < 500000 &&
        h >= Math.min(o, c) * 0.95 &&
        h <= Math.max(o, c) * 1.05 &&
        l >= Math.min(o, c) * 0.95 &&
        l <= Math.max(o, c) * 1.05 &&
        o > 0 &&
        h > 0 &&
        l > 0 &&
        c > 0
      )
        ohlcValid++;
      if (dateOff >= 0 && base + dateOff + 4 <= data.length) {
        const d = data.readInt32LE(base + dateOff);
        if (d >= 40000 && d <= 50000) {
          dateValid++;
          if (prevDate === 0 || (d >= prevDate && d <= prevDate + 14)) dateSeqOk++;
          prevDate = d;
        } else {
          prevDate = 0;
        }
      }
    }
    if (ohlcValid / N < 0.4) continue;
    const ohlcRate = ohlcValid / N,
      dateRate = dateOff >= 0 ? dateValid / N : 0;
    const seqRate = dateOff >= 0 ? dateSeqOk / Math.max(1, dateValid) : 0;
    const score = seqRate * 200 + dateRate * 100 + ohlcRate * 80 + (dateOff >= 0 ? 30 : 0);
    console.log(
      `  ${label}: nRecs=${nRecs.toString().padStart(6)}, ohlc=${ohlcValid}/${N}, date=${dateValid}/${N}, seq=${dateSeqOk}/${Math.max(1, dateValid)}, score=${score.toFixed(1)}`,
    );

    // 日期樣本
    if (dateOff >= 0 && dateValid > 0) {
      const dates = [];
      for (let ri = 0; ri < Math.min(5, nRecs); ri++) {
        const base = headerSize + ri * recSize;
        const d = data.readInt32LE(base + dateOff);
        if (d >= 40000 && d <= 50000) {
          const BASE = Date.UTC(1899, 11, 30);
          const dt = new Date(BASE + d * 86400000);
          dates.push(dt.toISOString().slice(0, 10));
        }
      }
      console.log(`    日期樣本: ${dates.join(", ")}`);
    }
  }
}

await testBlock("Block2 (TXF 15min?)", 28912012);
await testBlock("Block4 (TXF main)", 29535071);
await testBlock("Block5 (TWSE?)", 30030206);
await testBlock("Block10 (FXF?)", 49548493);
