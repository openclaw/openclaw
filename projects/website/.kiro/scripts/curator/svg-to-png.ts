#!/usr/bin/env tsx

/**
 * SVG 轉 PNG
 *
 * 使用方式：
 *   pnpm tsx svg-to-png.ts <input.svg> <output.png> [width] [height]
 */

import * as fs from 'fs';
import * as path from 'path';

async function svgToPng(inputPath: string, outputPath: string, width: number = 800, height: number = 600) {
  console.log("🎨 SVG 轉 PNG");
  console.log(`   輸入: ${inputPath}`);
  console.log(`   輸出: ${outputPath}`);
  console.log(`   尺寸: ${width}x${height}`);
  console.log("");

  // 讀取 SVG
  const svgContent = fs.readFileSync(inputPath, 'utf-8');

  // 使用 @resvg/resvg-js (需要安裝)
  // 或使用更簡單的方式：直接用 node-canvas

  console.log("⚠️  此腳本需要安裝額外套件：");
  console.log("   pnpm add @resvg/resvg-js");
  console.log("");
  console.log("或者使用線上工具：");
  console.log("   1. 打開 https://cloudconvert.com/svg-to-png");
  console.log("   2. 上傳 test-pricing-course5.svg");
  console.log("   3. 下載 PNG");
  console.log("");
  console.log("或者使用 Mac 的內建工具：");
  console.log("   qlmanage -t -s 1600 -o . test-pricing-course5.svg");
  console.log("   然後重新命名 test-pricing-course5.svg.png");
}

const [, , inputPath, outputPath, width, height] = process.argv;

if (!inputPath || !outputPath) {
  console.error("用法: pnpm tsx svg-to-png.ts <input.svg> <output.png> [width] [height]");
  process.exit(1);
}

svgToPng(
  inputPath,
  outputPath,
  width ? parseInt(width) : 800,
  height ? parseInt(height) : 600
);
