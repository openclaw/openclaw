/**
 * qmd-raw-dump.mjs — block2/block4 첫 160바이트 raw dump + 해석
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

function dumpRecord(data, base, recSize, label) {
  console.log(`  ${label} @offset ${base}:`);
  // hex dump
  const hexStr = [...data.slice(base, base + recSize)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log(`    hex: ${hexStr}`);
  // int32 interpretation
  const ints = [];
  for (let i = 0; i + 3 < recSize; i += 4) ints.push(data.readInt32LE(base + i));
  console.log(`    int32: [${ints.join(", ")}]`);
  // double interpretation
  const dbls = [];
  for (let i = 0; i + 7 < recSize; i += 8) dbls.push(data.readDoubleLE(base + i).toFixed(4));
  console.log(`    dbl:   [${dbls.join(", ")}]`);
  // OLE date check for each int32
  for (let i = 0; i + 3 < recSize; i += 4) {
    const v = data.readInt32LE(base + i);
    if (v >= 40000 && v <= 50000) {
      const BASE = Date.UTC(1899, 11, 30);
      const dt = new Date(BASE + v * 86400000);
      console.log(`    ★ OLE date at +${i}: ${v} = ${dt.toISOString().slice(0, 10)}`);
    }
    if (v >= 20200101 && v <= 20261231) {
      console.log(`    ★ YYYYMMDD at +${i}: ${v}`);
    }
  }
}

// Block2 분석 (40B × 8802, header=8 가정)
console.log("══ Block2 @28912012 (40B records with header=8?) ══");
const b2 = await loadBlock(28912012);
console.log(`  decompressed: ${b2.length} bytes`);
dumpRecord(b2, 0, 8, "inner header");
for (let i = 0; i < 5; i++) {
  dumpRecord(b2, 8 + i * 40, 40, `record[${i}] (40B)`);
}

// Block4 분석 (48B × 30798, header=8 가정)
console.log("\n══ Block4 @29535071 (48B records with header=8?) ══");
const b4 = await loadBlock(29535071);
console.log(`  decompressed: ${b4.length} bytes`);
dumpRecord(b4, 0, 8, "inner header");
for (let i = 0; i < 5; i++) {
  dumpRecord(b4, 8 + i * 48, 48, `record[${i}] (48B)`);
}
