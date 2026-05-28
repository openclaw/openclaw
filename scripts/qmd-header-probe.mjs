/**
 * qmd-header-probe.mjs — 각 블록의 첫 8바이트 내부 헤더 분석
 * QMD 블록이 내부 헤더(record count + version?)를 가지는지 확인
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

function hex8(data, off) {
  return [...data.slice(off, off + 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

const BLOCKS = [
  { name: "B2 @28912012", offset: 28912012 },
  { name: "B3 @29030277", offset: 29030277 },
  { name: "B4 @29535071", offset: 29535071 },
  { name: "B5 @30030206", offset: 30030206 },
  { name: "B6 @30038467", offset: 30038467 },
  { name: "B7 @30046728", offset: 30046728 },
  { name: "B10 @49548493", offset: 49548493 },
];

for (const { name, offset } of BLOCKS) {
  const data = await loadBlock(offset);
  const inner_h0 = data.readUInt32LE(0);
  const inner_h1 = data.readUInt32LE(4);
  const totalLen = data.length;

  // 嘗試每種 recSize，看 inner_h0 是否 == (totalLen - 8) / recSize
  const matches = [];
  for (const rs of [24, 32, 40, 48, 56, 64, 72, 80, 88, 96]) {
    const rem = totalLen - 8;
    if (rem > 0 && rem % rs === 0 && rem / rs === inner_h0) {
      matches.push(`★ recSize=${rs} (inner_h0 matches: ${inner_h0} recs)`);
    }
    if (rem > 0 && rem % rs === 0) {
      // also check without header
    }
  }
  // Also check if total / recSize matches inner_h0
  for (const rs of [24, 32, 40, 48, 56, 64, 72, 80, 88, 96]) {
    if (totalLen % rs === 0 && totalLen / rs === inner_h0) {
      matches.push(`  noHeader recSize=${rs} (inner_h0 matches as count: ${inner_h0} recs)`);
    }
  }

  // Divisors of totalLen and (totalLen-8) for context
  const divs40 =
    (totalLen - 8) % 40 === 0 ? `(totalLen-8)/40=${Math.round((totalLen - 8) / 40)}` : "";
  const divs48 =
    (totalLen - 8) % 48 === 0 ? `(totalLen-8)/48=${Math.round((totalLen - 8) / 48)}` : "";
  const divs64 =
    (totalLen - 8) % 64 === 0 ? `(totalLen-8)/64=${Math.round((totalLen - 8) / 64)}` : "";
  const divs88 = totalLen % 88 === 0 ? `totalLen/88=${Math.round(totalLen / 88)}` : "";

  console.log(`${name}: len=${totalLen}`);
  console.log(`  inner header: h0=${inner_h0} h1=${inner_h1} hex=[${hex8(data, 0)}]`);
  console.log(`  divisors: ${[divs40, divs48, divs64, divs88].filter(Boolean).join(", ")}`);
  if (matches.length) console.log(`  ${matches.join("\n  ")}`);

  // OHLC 位置自動搜索 (直接從 offset 0 和 8 找 double 在 TXF 範圍的欄位)
  console.log(`  first 32 doubles from offset 0:`);
  for (let i = 0; i < 8; i++) {
    const v = data.readDoubleLE(i * 8);
    const marker = v > 5000 && v < 100000 ? "★PRICE" : v > 100 && v < 100000 ? "●RANGE" : "";
    console.log(`    [+${(i * 8).toString().padStart(2)}] ${v.toFixed(4).padStart(14)} ${marker}`);
  }
  console.log();
}
