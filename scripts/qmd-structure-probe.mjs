/**
 * qmd-structure-probe.mjs
 * 深度分析 QMD 二進位格式的索引結構
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);

const QMD_PATH =
  "D:\\群益及元大API\\群益國內三年歷史資料包x64_202508\\國內三年歷史資料包\\群益MC12x64內期歷史資料包_20241212.qmd";

function hexRow(buf, offset, len = 16, label = "") {
  const s = buf.slice(offset, offset + len);
  const hex = Array.from(s, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const asc = Array.from(s, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
  const ints_le = [];
  for (let i = 0; i + 3 < s.length; i += 4) {
    ints_le.push(s.readUInt32LE(i));
  }
  console.log(
    `  [${(label || String(offset)).padEnd(8)}]  ${hex.padEnd(50)}  |${asc}|  LE32=[${ints_le.join(", ")}]`,
  );
}

async function tryDecomp(buf) {
  try {
    return await inflate(buf);
  } catch {}
  try {
    return await inflateRaw(buf);
  } catch {}
  return null;
}

async function main() {
  const fileSize = fs.statSync(QMD_PATH).size;
  console.log(`File: ${QMD_PATH}`);
  console.log(`Size: ${fileSize} bytes (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  const fd = fs.openSync(QMD_PATH, "r");

  // 讀前 2KB 詳細分析
  const buf2k = Buffer.alloc(2048);
  fs.readSync(fd, buf2k, 0, 2048, 0);

  console.log(`\n═══ 前 2048 bytes 詳細分析 ═══`);
  console.log(`─ 前 128 bytes:`);
  for (let i = 0; i < 128; i += 16) {
    hexRow(buf2k, i, 16, String(i));
  }

  // offset 12 = 1560 可能是某些重要的偏移
  // 讓我查看 1560 附近
  console.log(`\n─ offset 1544~1580 (圍繞 1560):`);
  for (let i = 1536; i < 1600; i += 16) {
    hexRow(buf2k, i, 16, String(i));
  }

  // 嘗試解壓 offset 1568 確認 XML catalog
  console.log(`\n─ offset 1568 嘗試解壓縮:`);
  const chunk1568 = buf2k.slice(1568);
  const dec1568 = await tryDecomp(chunk1568);
  if (dec1568) {
    console.log(`  ✅ inflate 成功: ${dec1568.length} bytes`);
    console.log(`  前 200 chars: ${dec1568.slice(0, 200).toString("utf8")}`);
  }

  // 分析頭部整數
  console.log(`\n═══ 頭部整數解析 ═══`);
  const header = {
    magic: buf2k.slice(0, 4).toString("ascii").replaceAll(String.fromCharCode(0), "\\0"),
    version: buf2k.readUInt32LE(4),
    field8: buf2k.readUInt32LE(8),
    field12: buf2k.readUInt32LE(12), // 1560
    field16: buf2k.readUInt32LE(16), // 38
    field20: buf2k.readUInt32LE(20), // 40
    field24: buf2k.readUInt32LE(24),
    field28: buf2k.readUInt32LE(28),
  };
  console.log(JSON.stringify(header, null, 2));

  // field12=1560, field16=38, field20=40 可能是:
  // - indexTableOffset=1560 (但 zlib 在 1568, 差 8)
  // - entryCount=38 or 40
  // 試試看 field12 是否為索引表的 byte-offset
  // 另外嘗試: 28 開始是否有一個固定長度的索引
  const entryCount = header.field16;
  const entrySize = header.field20; // 40 bytes per entry?
  const indexStart = 28; // 假設 28 bytes 之後是索引
  const indexEnd = indexStart + entryCount * entrySize;
  console.log(
    `\n假設: index from offset ${indexStart}, ${entryCount} entries × ${entrySize} bytes = ${indexStart + entryCount * entrySize} bytes total`,
  );
  console.log(`索引表估計結束於 offset ${indexEnd} (zlib@1568 的前一個結構)`);

  // 讀索引表
  console.log(`\n═══ 索引表 (offset ${indexStart}~${Math.min(indexEnd, 1568)}) ═══`);
  const indexBuf = buf2k.slice(indexStart, Math.min(indexEnd + 16, 1568));
  for (let i = 0; i < indexBuf.length; i += entrySize) {
    if (i + entrySize > indexBuf.length) {
      break;
    }
    const e = indexBuf.slice(i, i + entrySize);
    const values = [];
    for (let j = 0; j + 3 < entrySize; j += 4) {
      values.push(e.readUInt32LE(j));
    }
    const values8 = [];
    for (let j = 0; j + 7 < entrySize; j += 8) {
      values8.push(e.readBigUInt64LE(j));
    }
    const ascii = Array.from(e, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join(
      "",
    );
    console.log(`  entry[${i / entrySize}]: LE32=[${values.join(",")}] ascii="${ascii}"`);
    console.log(`              LE64=[${values8.join(",")}]`);
  }

  // 現在讓我試著理解 QMD 的全域索引
  // 讀取 1568 解壓後的 XML 的完整內容
  const bigBuf = Buffer.alloc(Math.min(fileSize, 10 * 1024 * 1024));
  fs.readSync(fd, bigBuf, 0, bigBuf.length, 1568);
  const xmlDecomp = await tryDecomp(bigBuf);
  if (xmlDecomp) {
    const xmlFull = xmlDecomp.toString("utf8");
    // 找出 XML 中有沒有 offset 或 size 信息
    const offsetRe = /offset="(\d+)"/g;
    const sizeRe = /size="(\d+)"/g;
    const blockRe = /block="(\d+)"/g;
    let m;
    const offsets = [],
      sizes = [],
      blocks = [];
    while ((m = offsetRe.exec(xmlFull)) !== null) {
      offsets.push(m[1]);
    }
    while ((m = sizeRe.exec(xmlFull)) !== null) {
      sizes.push(m[1]);
    }
    while ((m = blockRe.exec(xmlFull)) !== null) {
      blocks.push(m[1]);
    }
    console.log(`\n═══ XML 中的 offset/size/block 屬性 ═══`);
    console.log(`offset attrs: ${offsets.slice(0, 5).join(", ")} (total ${offsets.length})`);
    console.log(`size attrs:   ${sizes.slice(0, 5).join(", ")} (total ${sizes.length})`);
    console.log(`block attrs:  ${blocks.slice(0, 5).join(", ")} (total ${blocks.length})`);

    // 顯示完整 XML（它包含 25 個 symbol entry）
    // 找前 3 個 symbol 的詳細屬性
    const symRe = /<symbol ([^>]+)\/>/g;
    let si = 0;
    while ((m = symRe.exec(xmlFull)) !== null && si < 3) {
      console.log(`\n  symbol[${si}]: ${m[1]}`);
      si++;
    }
  }

  // 在 XML 的 zlib 壓縮資料之後，找下一個可讀的結構
  // 先確認 zlib@1568 的壓縮資料的確切長度
  // 方式：從 1568 開始，嘗試解壓縮不同長度
  console.log(`\n═══ 確認 zlib@1568 區塊長度 ═══`);
  // 找到解壓成功後緊接的下一個資料位置
  for (const tryLen of [4095 - 1568, 50000, 100000, 200000]) {
    const fd2 = fs.openSync(QMD_PATH, "r");
    const tryBuf = Buffer.alloc(tryLen);
    fs.readSync(fd2, tryBuf, 0, tryLen, 1568);
    fs.closeSync(fd2);
    try {
      const d = await inflate(tryBuf);
      if (d) {
        console.log(`  inflate(1568, len=${tryLen}) → ${d.length} bytes OK`);
      }
    } catch (e) {
      console.log(`  inflate(1568, len=${tryLen}) → ${e.message.slice(0, 50)}`);
    }
  }

  // 試著讀取 4095 之後的 32 bytes 了解下一個結構
  console.log(`\n─ offset 4080~4200 (圍繞第二個 zlib@4095):`);
  const buf4k = Buffer.alloc(256);
  fs.readSync(fd, buf4k, 0, 256, 4080);
  for (let i = 0; i < 256; i += 16) {
    hexRow(buf4k, i, 16, String(4080 + i));
  }

  // 嘗試從其他可能的入口讀取索引
  // MultiCharts QMD 格式可能有一個 TOC (Table of Contents)
  // 讓我檢查 field12=1560 位置前的內容
  console.log(`\n─ offset 1540~1570 (圍繞 field12=1560):`);
  const buf1540 = Buffer.alloc(64);
  fs.readSync(fd, buf1540, 0, 64, 1540);
  for (let i = 0; i < 64; i += 16) {
    hexRow(buf1540, i, 16, String(1540 + i));
  }

  fs.closeSync(fd);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
