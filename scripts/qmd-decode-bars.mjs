/**
 * qmd-decode-bars.mjs
 * 解碼 QMD 二進位 K 棒格式，找出實際 OHLCV 數值
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const QMD =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

// 索引（從 qmd-structure-probe 分析）
const BLOCKS = [
  { seq: 1, offset: 4087, name: "FXF_or_TXF_large" },
  { seq: 2, offset: 28912012, name: "block2" },
  { seq: 3, offset: 29030277, name: "block3" },
  { seq: 4, offset: 29535071, name: "block4" },
  { seq: 5, offset: 30030206, name: "block5_daily?" },
  { seq: 6, offset: 30038467, name: "block6_daily?" },
  { seq: 7, offset: 30046728, name: "block7_quarterly?" },
  { seq: 8, offset: 30172359, name: "block8_small" },
  { seq: 9, offset: 30177556, name: "block9_large" },
  { seq: 10, offset: 49548493, name: "block10" },
];

// OLE Automation Date to ISO string
// Days from 1899-12-30
function oleDate(d) {
  if (d < 1 || d > 200000) {
    return `??(${d.toFixed(4)})`;
  }
  const ms = (d - 25569) * 86400 * 1000; // 25569 = days from 1899-12-30 to 1970-01-01
  const dt = new Date(ms);
  const yr = dt.getUTCFullYear(),
    mo = String(dt.getUTCMonth() + 1).padStart(2, "0"),
    dy = String(dt.getUTCDate()).padStart(2, "0");
  const hr = String(dt.getUTCHours()).padStart(2, "0"),
    mn = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${yr}-${mo}-${dy} ${hr}:${mn}`;
}

// 嘗試將 8 bytes 解讀為 OLE date
function tryOleDate(buf, offset) {
  if (offset + 8 > buf.length) {
    return null;
  }
  const d = buf.readDoubleLE(offset);
  if (d > 30000 && d < 60000) {
    return oleDate(d);
  }
  return null;
}

async function decodeBlock(blockInfo) {
  const { seq, offset, name } = blockInfo;
  const fd = fs.openSync(QMD, "r");

  // 讀 8-byte 區塊頭
  const hdr = Buffer.alloc(8);
  fs.readSync(fd, hdr, 0, 8, offset);
  const compSize = hdr.readUInt32LE(4);

  // 解壓縮
  const compBuf = Buffer.alloc(compSize);
  fs.readSync(fd, compBuf, 0, compSize, offset + 8);
  fs.closeSync(fd);

  let data;
  try {
    data = await inflate(compBuf);
  } catch {
    return;
  }
  if (!data) {
    return;
  }

  console.log(`\n═══ Block ${seq} "${name}" ═══`);
  console.log(`壓縮大小: ${compSize} bytes, 解壓縮: ${data.length} bytes`);

  // 嘗試各種 record size
  const RECORD_SIZES = [24, 32, 40, 48, 56, 64];
  let best = null;

  for (const rs of RECORD_SIZES) {
    const headerSizes = [0, 4, 8, 12, 16];
    for (const hs of headerSizes) {
      const payload = data.length - hs;
      if (payload <= 0 || payload % rs !== 0) {
        continue;
      }
      const nRecs = payload / rs;

      // 讀前 5 筆
      let validCount = 0;
      const sample = [];
      for (let i = 0; i < Math.min(5, nRecs); i++) {
        const off = hs + i * rs;
        const rec = {};

        // 嘗試 OLE date (first 8 bytes)
        const oleD = tryOleDate(data, off);
        if (oleD) {
          rec.date = oleD;
          rec.isValidDate = true;
        } else {
          // 嘗試 int32 日期 YYYYMMDD
          const v = data.readUInt32LE(off);
          if (v >= 20150101 && v <= 20241231) {
            rec.date = `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}`;
            rec.isValidDate = true;
          }
        }

        // 讀 doubles（跳過頭 8 bytes if OLE date）
        const priceOffset = rec.isValidDate ? off + 8 : off;
        const prices = [];
        for (let p = priceOffset; p + 8 <= off + rs; p += 8) {
          const v = data.readDoubleLE(p);
          if (v > 100 && v < 500000) {
            prices.push(v);
          }
        }

        if (prices.length >= 3) {
          rec.prices = prices.slice(0, 6).map((p) => p.toFixed(2));
          // 驗證 O <= H, O >= L (基本 OHLC 關係)
          if (prices.length >= 4) {
            const [o, h, l, c] = prices;
            if (h >= Math.max(o, c) && l <= Math.min(o, c)) {
              rec.ohlcValid = true;
              validCount++;
            }
          }
        }
        sample.push(rec);
      }

      if (validCount >= 2 || (sample[0]?.isValidDate && sample[0]?.prices?.length >= 3)) {
        const score = validCount + (sample[0]?.isValidDate ? 2 : 0);
        if (!best || score > best.score) {
          best = { rs, hs, nRecs, sample, score };
        }
      }
    }
  }

  if (best) {
    const { rs, hs, nRecs, sample } = best;
    console.log(`★ 最佳格式: header=${hs}B + record=${rs}B × ${nRecs} 筆`);
    console.log(`  樣本:`);
    sample.forEach((rec, i) => {
      console.log(
        `  [${i}] date=${rec.date || "?"} prices=[${rec.prices?.join(", ") || "N/A"}] ohlcValid=${rec.ohlcValid || false}`,
      );
    });

    // 計算日期範圍
    const lastRecOff = hs + (nRecs - 1) * rs;
    const lastOle = tryOleDate(data, lastRecOff);
    const lastPrices = [];
    for (let p = lastRecOff + 8; p + 8 <= lastRecOff + rs; p += 8) {
      const v = data.readDoubleLE(p);
      if (v > 100 && v < 500000) {
        lastPrices.push(v.toFixed(2));
      }
    }
    console.log(`  最後一筆: date=${lastOle || "?"} prices=[${lastPrices.slice(0, 4).join(", ")}]`);
  } else {
    console.log(`❌ 無法識別記錄格式`);
    // 嘗試直接讀 doubles 從 offset 8
    console.log(`  raw doubles (offset 8, first 10):`);
    for (let i = 0; i < 10 && 8 + i * 8 + 8 <= data.length; i++) {
      const v = data.readDoubleLE(8 + i * 8);
      const rawBytes = Array.from(data.slice(8 + i * 8, 8 + i * 8 + 8), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(" ");
      console.log(`    [${i}] = ${v.toFixed(4)} (raw bytes: ${rawBytes})`);
    }
  }
}

async function main() {
  for (let i = 0; i < BLOCKS.length; i++) {
    await decodeBlock(BLOCKS[i]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
