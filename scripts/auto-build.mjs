#!/usr/bin/env node

// 自动打包部署脚本 (Node.js 版本)

import { execSync } from "child_process";
import { mkdirSync, rmSync, copyFileSync, cpSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORK_DIR = resolve(__dirname, "..");

// 品牌名称
const BRAND_NAME = "JSClaw";

// 输出目录
const OUTPUT_DIR = resolve(WORK_DIR, "deploy");
const BRAND_DIR = resolve(OUTPUT_DIR, BRAND_NAME);

console.log("=== 自动打包部署脚本 ===\n");

// 检查pnpm是否安装
function checkPNPM() {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

// 确保pnpm安装
if (!checkPNPM()) {
  console.error("错误: pnpm 未安装！");
  console.error("请先安装 pnpm: npm install -g pnpm");
  process.exit(1);
}

// 确保输出目录存在
try {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log("[1/4] 输出目录准备完成");
} catch (error) {
  console.error("创建输出目录失败:", error.message);
  process.exit(1);
}

// 1. 下载依赖
try {
  console.log("[2/4] 正在下载依赖...");
  execSync("pnpm install", { cwd: WORK_DIR, stdio: "inherit" });
  console.log("依赖安装成功");
} catch (error) {
  console.error("依赖安装失败:", error.message);
  process.exit(1);
}

// 2. 打包UI
try {
  console.log("[3/4] 正在打包UI...");
  execSync("pnpm ui:build", { cwd: WORK_DIR, stdio: "inherit" });
  console.log("UI打包成功");
} catch (error) {
  console.error("UI打包失败:", error.message);
  process.exit(1);
}

// 3. 整体打包
try {
  console.log("[4/4] 正在整体打包...");
  execSync("pnpm build", { cwd: WORK_DIR, stdio: "inherit" });
  console.log("整体打包成功");
} catch (error) {
  console.error("整体打包失败:", error.message);
  process.exit(1);
}

// 4. 复制文件并压缩
try {
  console.log("\n[5/4] 正在复制文件并压缩...");

  // 清理旧的品牌目录
  try {
    rmSync(BRAND_DIR, { recursive: true, force: true });
  } catch (error) {
    // 忽略错误
  }

  // 创建品牌目录
  mkdirSync(BRAND_DIR, { recursive: true });

  // 复制文件
  cpSync(resolve(WORK_DIR, "dist"), resolve(BRAND_DIR, "dist"), { recursive: true });
  copyFileSync(resolve(WORK_DIR, "package.json"), resolve(BRAND_DIR, "package.json"));
  copyFileSync(resolve(WORK_DIR, "pnpm-lock.yaml"), resolve(BRAND_DIR, "pnpm-lock.yaml"));
  copyFileSync(resolve(WORK_DIR, "openclaw.mjs"), resolve(BRAND_DIR, "openclaw.mjs"));
  copyFileSync(resolve(WORK_DIR, "auto-deploy.mjs"), resolve(BRAND_DIR, "auto-deploy.mjs"));

  console.log("文件复制成功");

  // 压缩文件夹
  const zipPath = resolve(OUTPUT_DIR, `${BRAND_NAME}.zip`);
  try {
    rmSync(zipPath, { force: true });
  } catch (error) {
    // 忽略错误
  }

  // 使用 zip 命令或其他方式压缩
  try {
    execSync(`zip -r "${zipPath}" "${BRAND_NAME}"`, { cwd: OUTPUT_DIR, stdio: "inherit" });
    console.log("压缩成功");
  } catch (error) {
    console.warn("zip命令失败，尝试使用其他方式...");
    // 这里可以添加其他压缩方式的逻辑
  }

  // 清理临时文件
  rmSync(BRAND_DIR, { recursive: true, force: true });

  console.log("\n打包部署完成！");
  console.log(`输出文件: ${zipPath}`);
} catch (error) {
  console.error("复制文件或压缩失败:", error.message);
  process.exit(1);
}
