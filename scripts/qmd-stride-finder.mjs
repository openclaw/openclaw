/**
 * qmd-stride-finder.mjs — OHLC 패턴의 stride를 역방향으로 계산
 * 연속된 OHLC 그룹 사이의 간격을 찾아서 실제 record size 확인
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

function isValidOHLC(o, h, l, c, minP, maxP) {
  return (
    o > minP &&
    o < maxP &&
    h > minP &&
    h < maxP &&
    l > minP &&
    l < maxP &&
    c > minP &&
    c < maxP &&
    h >= Math.max(o, c) * 0.999 &&
    h <= Math.max(o, c) * 1.005 &&
    l <= Math.min(o, c) * 1.001 &&
    l >= Math.min(o, c) * 0.995
  );
}

async function findOhlcStride(blockOffset, minP, maxP, label) {
  const data = await loadBlock(blockOffset);
  console.log(`\n${label}: ${data.length} bytes, price range ${minP}-${maxP}`);

  // 8-byte aligned position에서 OHLC 시작점 찾기
  const ohlcPositions = [];
  for (let i = 0; i + 32 <= data.length; i += 8) {
    const o = data.readDoubleLE(i);
    const h = data.readDoubleLE(i + 8);
    const l = data.readDoubleLE(i + 16);
    const c = data.readDoubleLE(i + 24);
    if (isValidOHLC(o, h, l, c, minP, maxP)) {
      ohlcPositions.push(i);
    }
  }

  console.log(`  Found ${ohlcPositions.length} OHLC groups`);
  if (ohlcPositions.length < 10) {
    console.log(`  positions: ${ohlcPositions.slice(0, 20).join(", ")}`);
    return;
  }

  // 연속된 OHLC 위치들 사이의 gap 계산
  const gaps = {};
  for (let i = 1; i < Math.min(ohlcPositions.length, 200); i++) {
    const gap = ohlcPositions[i] - ohlcPositions[i - 1];
    gaps[gap] = (gaps[gap] || 0) + 1;
  }

  // 가장 많이 나오는 gap = 실제 record stride
  const sortedGaps = Object.entries(gaps)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log(`  Top gaps (stride candidates):`);
  for (const [gap, cnt] of sortedGaps) {
    const expectedRecs = Math.round((data.length - 8) / Number(gap));
    console.log(`    gap=${gap} bytes → ${cnt} occurrences, expected ${expectedRecs} recs`);
  }

  // 가장 큰 count의 gap으로 stride 결정
  const bestStride = Number(sortedGaps[0][0]);
  console.log(`\n  → Best stride: ${bestStride} bytes per bar`);

  // 첫 5개 bar 내용 출력
  let barCount = 0;
  for (let i = 0; i < ohlcPositions.length && barCount < 5; i++) {
    const pos = ohlcPositions[i];
    // 이 pos가 valid stride에서 오는지 확인
    if (i === 0 || ohlcPositions[i] - ohlcPositions[i - 1] === bestStride) {
      const o = data.readDoubleLE(pos);
      const h = data.readDoubleLE(pos + 8);
      const l = data.readDoubleLE(pos + 16);
      const c = data.readDoubleLE(pos + 24);
      // OLE date: scan nearby int32s for valid dates
      let dateStr = "?";
      for (let j = pos + 32; j < pos + bestStride && j + 4 <= data.length; j += 4) {
        const v = data.readInt32LE(j);
        if (v >= 40000 && v <= 50000) {
          const dt = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
          dateStr = dt.toISOString().slice(0, 10);
          break;
        }
      }
      // volume: int64 at pos+32
      let vol = 0;
      if (pos + 40 <= data.length) {
        const maybeVol = Number(data.readBigInt64LE(pos + 32));
        if (maybeVol > 0 && maybeVol < 10_000_000) vol = maybeVol;
      }
      console.log(
        `  bar[${barCount}] @${pos}: O=${o.toFixed(2)} H=${h.toFixed(2)} L=${l.toFixed(2)} C=${c.toFixed(2)} V=${vol} date=${dateStr}`,
      );
      barCount++;
    }
  }
}

// Block4 (TXF, 16000-18000)
await findOhlcStride(29535071, 15000, 20000, "Block4 (TXF ~16500)");

// Block2 (TXF, 16000-18000)
await findOhlcStride(28912012, 15000, 20000, "Block2 (TXF ~16850)");

// Block10 (FXF, 1000-2000)
await findOhlcStride(49548493, 800, 3000, "Block10 (FXF ~1130)");

// Block5 (TWSE, 20000-25000)
await findOhlcStride(30030206, 18000, 26000, "Block5 (TWSE ~23000)");
