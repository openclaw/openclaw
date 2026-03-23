#!/usr/bin/env node

import { execSync } from "child_process";
import { mkdirSync, rmSync, copyFileSync, cpSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORK_DIR = resolve(__dirname, "..");

// 从品牌配置文件中读取品牌名称
function getBrandName() {
  try {
    const brandConfigPath = resolve(WORK_DIR, "ui", "src", "brand-config.ts");
    const brandConfigContent = readFileSync(brandConfigPath, "utf8");
    const match = brandConfigContent.match(/name:\s*["']([^"']+)["']/);
    if (match && match[1]) {
      return match[1].trim();
    }
    console.warn("无法从品牌配置文件中读取品牌名称，使用默认值 'JSClaw'");
    return "JSClaw";
  } catch (error) {
    console.warn("读取品牌配置文件失败，使用默认值 'JSClaw':", error.message);
    return "JSClaw";
  }
}

// 品牌名称
const BRAND_NAME = getBrandName();

// 输出目录
const OUTPUT_DIR = resolve(WORK_DIR, "deploy");
const BRAND_DIR = resolve(OUTPUT_DIR, BRAND_NAME);

console.log("=== 自动打包脚本 ===\n");

// 检查pnpm是否安装
function checkPNPM() {
  try {
    execSync("pnpm --version", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

// 安装pnpm
function installPNPM() {
  console.log("pnpm未安装，正在安装...");
  try {
    execSync("npm install -g pnpm", { stdio: "inherit" });
    console.log("pnpm安装成功！");
    return true;
  } catch (error) {
    console.error("pnpm安装失败:", error.message);
    return false;
  }
}

// 确保pnpm安装
if (!checkPNPM()) {
  if (!installPNPM()) {
    console.error("无法安装pnpm，请手动安装: npm install -g pnpm");
    process.exit(1);
  }
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
async function copyAndCompress() {
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
    let compressionSuccess = false;

    try {
      rmSync(zipPath, { force: true });
    } catch (error) {
      // 忽略错误
    }

    // 使用Node.js的archiver包进行压缩
    try {
      console.log("正在压缩文件...");

      // 尝试使用archiver包
      let archiver;
      try {
        // 尝试 require 本地安装的 archiver
        archiver = require("archiver");
      } catch (requireError) {
        // 如果没有安装，尝试安装
        console.log("archiver包未安装，正在安装...");
        execSync("npm install archiver", { cwd: WORK_DIR, stdio: "inherit" });
        archiver = require("archiver");
      }

      const fs = require("fs");
      const path = require("path");

      // 创建输出流
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", {
        zlib: { level: 9 }, // 最高压缩级别
      });

      // 监听完成事件
      output.on("close", function () {
        console.log(`压缩成功，总大小: ${archive.pointer()} 字节`);
        compressionSuccess = true;
      });

      // 监听错误事件
      archive.on("error", function (err) {
        throw err;
      });

      // 管道连接
      archive.pipe(output);

      // 添加目录
      archive.directory(path.join(OUTPUT_DIR, BRAND_NAME), BRAND_NAME);

      // 完成压缩
      archive.finalize();

      // 等待压缩完成
      await new Promise((resolve, reject) => {
        output.on("close", resolve);
        archive.on("error", reject);
      });
    } catch (error) {
      console.error("压缩失败:", error.message);
      compressionSuccess = false;
    }

    // 清理临时文件
    rmSync(BRAND_DIR, { recursive: true, force: true });

    if (compressionSuccess) {
      console.log("\n打包完成！");
      console.log(`输出文件: ${zipPath}`);
      console.log("\n下一步操作:");
      console.log("1. 解压生成的zip文件到目标服务器");
      console.log("2. 在目标服务器上执行: node auto-deploy.mjs");
    } else {
      console.error("\n打包完成，但压缩失败！");
      console.error("请手动压缩deploy目录中的文件");
      process.exit(1);
    }
  } catch (error) {
    console.error("复制文件或压缩失败:", error.message);
    process.exit(1);
  }
}

// 执行复制和压缩
copyAndCompress();
