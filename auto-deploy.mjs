#!/usr/bin/env node

// 自动安装脚本

import { execSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORK_DIR = __dirname;

console.log("=== 自动安装脚本 ===\n");

// 检查pm2是否安装
function checkPM2() {
  try {
    execSync("pm2 --version", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

// 安装pm2
function installPM2() {
  console.log("pm2未安装，正在安装...");
  try {
    execSync("npm install -g pm2", { stdio: "inherit" });
    console.log("pm2安装成功！");
    return true;
  } catch (error) {
    console.error("pm2安装失败:", error.message);
    return false;
  }
}

// 检查并安装依赖
function installDependencies() {
  console.log("正在安装依赖...");
  try {
    execSync("pnpm install", { cwd: WORK_DIR, stdio: "inherit" });
    console.log("依赖安装成功");
    return true;
  } catch (error) {
    console.error("依赖安装失败:", error.message);
    return false;
  }
}

// 主函数
async function main() {
  // 检查并安装pm2
  if (!checkPM2()) {
    if (!installPM2()) {
      process.exit(1);
    }
  }

  // 安装依赖
  if (!installDependencies()) {
    process.exit(1);
  }

  // 显示访问地址
  console.log("\n访问地址：");
  console.log("Web UI: http://localhost:18789");
  console.log("网关: ws://localhost:18789");

  console.log("\n安装完成！");
}

// 执行主函数
main().catch((error) => {
  console.error("安装过程中出错:", error.message);
  process.exit(1);
});
