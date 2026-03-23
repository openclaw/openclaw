#!/usr/bin/env node

import { execSync } from "child_process";
import { mkdirSync, rmSync, copyFileSync, cpSync, readFileSync, existsSync } from "fs";
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

// 2. 整体打包
try {
  console.log("[3/4] 正在整体打包...");
  execSync("pnpm build", { cwd: WORK_DIR, stdio: "inherit" });
  console.log("整体打包成功");
} catch (error) {
  console.error("整体打包失败:", error.message);
  process.exit(1);
}

// 3. 打包UI
try {
  console.log("[4/4] 正在打包UI...");
  execSync("pnpm ui:build", { cwd: WORK_DIR, stdio: "inherit" });
  console.log("UI打包成功");
} catch (error) {
  console.error("UI打包失败:", error.message);
  process.exit(1);
}

// 4. 复制文件
function copyFiles() {
  try {
    console.log("\n[5/4] 正在复制文件...");

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

    // 复制品牌配置文件
    try {
      const brandConfigPath = resolve(WORK_DIR, "ui", "src", "brand-config.ts");
      if (existsSync(brandConfigPath)) {
        const brandConfigDestPath = resolve(BRAND_DIR, "ui", "src");
        mkdirSync(brandConfigDestPath, { recursive: true });
        copyFileSync(brandConfigPath, resolve(brandConfigDestPath, "brand-config.ts"));
        console.log("品牌配置文件复制成功");
      }
    } catch (error) {
      console.warn("复制品牌配置文件失败:", error.message);
      // 继续执行，不中断打包过程
    }

    // 复制文档模板文件（解决 Missing workspace template 错误）
    try {
      const docsDir = resolve(WORK_DIR, "docs");
      if (existsSync(docsDir)) {
        cpSync(docsDir, resolve(BRAND_DIR, "docs"), { recursive: true });
        console.log("文档模板文件复制成功");
      }
    } catch (error) {
      console.warn("复制文档模板文件失败:", error.message);
      // 继续执行，不中断打包过程
    }

    console.log("文件复制成功");
    console.log("\n打包完成！");
    console.log(`输出目录: ${BRAND_DIR}`);
    console.log("\n下一步操作:");
    console.log("1. 将生成的目录复制到目标服务器");
    console.log("2. 在目标服务器上执行: node auto-deploy.mjs");
  } catch (error) {
    console.error("复制文件失败:", error.message);
    process.exit(1);
  }
}

// 执行复制文件
copyFiles();
