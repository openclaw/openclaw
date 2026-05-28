/**
 * qmd-find-dates.mjs
 * 精確找出 QMD 記錄中日期欄位的位置和格式
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const QMD =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

// OLE Automation Date → ISO 8601
function oleDate2Str(d) {
  const BASE = new Date(1899, 11, 30, 0, 0, 0, 0).getTime(); // 1899-12-30 UTC
  const dt = new Date(BASE + d * 86400000);
  const y = dt.getUTCFullYear(),
    m = String(dt.getUTCMonth() + 1).padStart(2, "0"),
    d2 = String(dt.getUTCDate()).padStart(2, "0");
  const h = String(dt.getUTCHours()).padStart(2, "0"),
    mi = String(dt.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d2} ${h}:${mi}`;
}

// Windows FILETIME → ISO 8601
function fileTime2Str(bigIntVal) {
  const EPOCH_DIFF = 116444736000000000n; // 100-ns intervals from 1601 to 1970
  const ms = Number((bigIntVal - EPOCH_DIFF) / 10000n);
  if (ms < 0 || ms > 2e12) {
    return null;
  }
  const dt = new Date(ms);
  return dt.toISOString().slice(0, 16);
}

// Unix timestamp (seconds) → ISO 8601
function unixSec2Str(s) {
  if (s < 1000000000 || s > 2000000000) {
    return null;
  }
  const dt = new Date(s * 1000);
  return dt.toISOString().slice(0, 16);
}

async function decompBlock(fileOffset, compSize) {
  const fd = fs.openSync(QMD, "r");
  const hdr = Buffer.alloc(8);
  fs.readSync(fd, hdr, 0, 8, fileOffset);
  const actualCompSize = hdr.readUInt32LE(4);
  const readSize = Math.min(actualCompSize, compSize || actualCompSize);
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, fileOffset + 8);
  fs.closeSync(fd);
  try {
    return await inflate(buf);
  } catch {
    return null;
  }
}

function analyzeRecord(data, recOffset, recSize) {
  const rec = data.slice(recOffset, recOffset + recSize);
  const result = {
    bytes: Array.from(rec.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(" "),
  };

  // 每 8 bytes 嘗試所有解讀
  const interpretations = [];
  for (let i = 0; i + 7 < recSize; i += 8) {
    if (recOffset + i + 8 > data.length) {
      break;
    }
    const slice = data.slice(recOffset + i, recOffset + i + 8);
    const dbl = slice.readDoubleLE(0);
    const i32a = slice.readInt32LE(0);
    const i32b = slice.readInt32LE(4);
    const u64 = slice.readBigUInt64LE(0);

    const info = { offset: i, dbl: dbl.toFixed(4), i32a, i32b };

    // 日期偵測
    if (dbl > 44000 && dbl < 50000) {
      info.oleDate = oleDate2Str(dbl); // OLE date as double
    }
    if (i32a >= 44000 && i32a <= 50000) {
      info.oleDateInt = oleDate2Str(i32a); // OLE date as int32
    }
    if (i32a >= 20200101 && i32a <= 20251231) {
      info.yyyymmdd = `${i32a}`; // YYYYMMDD
    }

    // 時間偵測
    const timeCandidate = unixSec2Str(Number(u64));
    if (timeCandidate) {
      info.unixSec = timeCandidate;
    }
    const ftStr = fileTime2Str(u64);
    if (ftStr) {
      info.fileTime = ftStr;
    }

    interpretations.push(info);
  }
  return { ...result, fields: interpretations };
}

async function findDatesInBlock(blockName, fileOffset, compSize, headerBytes, recSize, numRecs) {
  console.log(`\n═══ ${blockName} (header=${headerBytes}B + record=${recSize}B × ${numRecs}) ═══`);
  const data = await decompBlock(fileOffset, compSize);
  if (!data) {
    console.log("❌ 無法解壓縮");
    return;
  }

  // 分析前 5 筆記錄
  for (let i = 0; i < Math.min(5, numRecs); i++) {
    const off = headerBytes + i * recSize;
    const rec = analyzeRecord(data, off, recSize);
    console.log(`\n  record[${i}] @${off}:`);
    rec.fields.forEach((f) => {
      const extras = [];
      if (f.oleDate) {
        extras.push(`OLE_date=${f.oleDate}`);
      }
      if (f.oleDateInt) {
        extras.push(`OLE_int=${f.oleDateInt}`);
      }
      if (f.yyyymmdd) {
        extras.push(`YYYYMMDD=${f.yyyymmdd}`);
      }
      if (f.unixSec) {
        extras.push(`unixSec=${f.unixSec}`);
      }
      if (f.fileTime) {
        extras.push(`fileTime=${f.fileTime}`);
      }
      const priceFlag = f.dbl > 1000 && f.dbl < 200000 ? "★PRICE★" : "";
      console.log(
        `    [+${f.offset}] dbl=${Number.parseFloat(f.dbl).toFixed(2).padStart(12)} i32=[${String(f.i32a).padStart(12)}, ${String(f.i32b).padStart(10)}] ${priceFlag} ${extras.join(" ")}`,
      );
    });
  }
}

async function main() {
  // Block 2: 8802 records × 40 bytes (header=8)
  await findDatesInBlock("Block2 (TXF ~16850, 40B×8802)", 28912012, 118257, 8, 40, 8802);

  // Block 5: 367 records × 64 bytes (header=8)
  await findDatesInBlock("Block5 (TWSE ~23000, 64B×367)", 30030206, 8253, 8, 64, 367);

  // Block 7: 10518 records × 40 bytes (header=8)
  await findDatesInBlock("Block7 (5900~6170, 40B×10518)", 30046728, 125623, 8, 40, 10518);

  // Block 10: 8650 records × 64 bytes (header=8)
  await findDatesInBlock("Block10 (~1130, 64B×8650)", 49548493, 129260, 8, 64, 8650);

  // Block 4 with 48-byte records (special): try header=8, record=48
  console.log(`\n═══ Block4 嘗試 header=8 + record=48 ═══`);
  const data4 = await decompBlock(29535071, 495127);
  if (data4) {
    const n48 = (data4.length - 8) / 48;
    console.log(`  decompressed=${data4.length}, (${data4.length}-8)/48 = ${n48}`);
    for (let i = 0; i < Math.min(3, n48); i++) {
      const off = 8 + i * 48;
      const rec = analyzeRecord(data4, off, 48);
      console.log(`\n  record48[${i}] @${off}:`);
      rec.fields.forEach((f) => {
        const extras = [];
        if (f.oleDate) {
          extras.push(`OLE_date=${f.oleDate}`);
        }
        if (f.oleDateInt) {
          extras.push(`OLE_int=${f.oleDateInt}`);
        }
        if (f.yyyymmdd) {
          extras.push(`YYYYMMDD=${f.yyyymmdd}`);
        }
        if (f.unixSec) {
          extras.push(`unixSec=${f.unixSec}`);
        }
        const priceFlag = f.dbl > 1000 && f.dbl < 200000 ? "★PRICE★" : "";
        console.log(
          `    [+${f.offset}] dbl=${Number.parseFloat(f.dbl).toFixed(2).padStart(12)} i32=[${f.i32a}, ${f.i32b}] ${priceFlag} ${extras.join(" ")}`,
        );
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
