#!/usr/bin/env node

// 自动部署脚本

import { execSync, exec } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath, readFileSync } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORK_DIR = __dirname;

console.log("=== 自动部署脚本 ===\n");

// 从品牌配置文件中读取品牌名称
function getBrandName() {
  try {
    const brandConfigPath = resolve(WORK_DIR, "ui", "src", "brand-config.ts");
    const brandConfigContent = readFileSync(brandConfigPath, "utf8");
    const match = brandConfigContent.match(/name:\s*["']([^"']+)["']/);
    if (match && match[1]) {
      return match[1].trim().toLowerCase();
    }
    console.warn("无法从品牌配置文件中读取品牌名称，使用默认值 'jsclaw'");
    return "jsclaw";
  } catch (error) {
    console.warn("读取品牌配置文件失败，使用默认值 'jsclaw':", error.message);
    return "jsclaw";
  }
}

// 品牌名称
const BRAND_NAME = getBrandName();

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

// 停止现有的服务
function stopExistingServices() {
  console.log("正在停止现有服务...");
  try {
    execSync("pm2 stop all", { stdio: "inherit" });
    execSync("pm2 delete all", { stdio: "inherit" });
    console.log("现有服务已停止并删除");
  } catch (error) {
    console.warn("停止服务时出错:", error.message);
  }
}

// 检查依赖
function checkDependencies() {
  console.log("正在检查依赖...");
  try {
    execSync("npm list", { cwd: WORK_DIR, stdio: "ignore" });
    console.log("依赖检查完成");
  } catch (error) {
    console.warn("依赖可能未安装，正在安装...");
    try {
      execSync("npm install", { cwd: WORK_DIR, stdio: "inherit" });
      console.log("依赖安装成功");
    } catch (installError) {
      console.error("依赖安装失败:", installError.message);
      return false;
    }
  }
  return true;
}

// 启动网关服务
function startGateway() {
  console.log("正在启动网关服务...");
  try {
    execSync(`pm2 start openclaw.mjs --name "${BRAND_NAME}-gateway" -- gateway`, {
      cwd: WORK_DIR,
      stdio: "inherit",
    });
    console.log("网关服务启动成功");
    return true;
  } catch (error) {
    console.error("网关服务启动失败:", error.message);
    // 查看详细日志
    try {
      execSync(`pm2 logs ${BRAND_NAME}-gateway --lines 50`, { stdio: "inherit" });
    } catch (logError) {
      console.error("查看日志失败:", logError.message);
    }
    return false;
  }
}

// 启动Web UI
function startDashboard() {
  console.log("正在启动Web UI...");
  try {
    execSync(`pm2 start openclaw.mjs --name "${BRAND_NAME}-dashboard" -- dashboard`, {
      cwd: WORK_DIR,
      stdio: "inherit",
    });
    console.log("Web UI启动成功");
    return true;
  } catch (error) {
    console.error("Web UI启动失败:", error.message);
    // 查看详细日志
    try {
      execSync(`pm2 logs ${BRAND_NAME}-dashboard --lines 50`, { stdio: "inherit" });
    } catch (logError) {
      console.error("查看日志失败:", logError.message);
    }
    return false;
  }
}

// 显示服务状态
function showStatus() {
  console.log("\n服务状态：");
  try {
    execSync("pm2 status", { stdio: "inherit" });
  } catch (error) {
    console.error("显示状态失败:", error.message);
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

  // 检查依赖
  if (!checkDependencies()) {
    process.exit(1);
  }

  // 停止现有服务
  stopExistingServices();

  // 启动网关服务
  if (!startGateway()) {
    process.exit(1);
  }

  // 等待网关服务启动
  console.log("等待网关服务启动...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 启动Web UI
  if (!startDashboard()) {
    process.exit(1);
  }

  // 等待Web UI启动
  console.log("等待Web UI启动...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 显示服务状态
  showStatus();

  // 显示访问地址
  console.log("\n访问地址：");
  console.log("Web UI: http://localhost:18789");
  console.log("网关: ws://localhost:18789");

  console.log("\n部署完成！");
}

// 执行主函数
main().catch((error) => {
  console.error("部署过程中出错:", error.message);
  process.exit(1);
});
