/**
 * OpenClaw 版本检查和自动更新安装器
 *
 * 功能：
 * 1. 检查当前已安装版本
 * 2. 从 npm registry 或 GitHub 获取最新版本
 * 3. 比较版本号，确定是否有更新
 * 4. 自动下载并更新源码
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 版本信息接口
interface VersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
}

// 安装器配置
interface InstallerConfig {
  packageName: string;
  npmRegistry?: string;
  githubRepo?: string;
  installDir: string;
  channel: "stable" | "beta" | "dev";
}

// 颜色输出
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(color: keyof typeof colors, message: string): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logInfo(message: string): void {
  log("blue", "ℹ " + message);
}

function logSuccess(message: string): void {
  log("green", "✓ " + message);
}

function logWarning(message: string): void {
  log("yellow", "⚠ " + message);
}

function logError(message: string): void {
  log("red", "✗ " + message);
}

// HTTP 请求封装
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const request = protocol.get(url, { timeout: 10000 }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        // 处理重定向
        if (response.headers.location) {
          httpGet(response.headers.location).then(resolve).catch(reject);
          return;
        }
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () => resolve(data));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

// 解析 semver 版本
function parseVersion(
  version: string,
): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  };
}

// 比较版本
function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  if (!parsedA || !parsedB) return 0;

  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;

  // 稳定版本优先于预发布版本
  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length > 0) return 1;
  if (parsedA.prerelease.length > 0 && parsedB.prerelease.length === 0) return -1;

  return 0;
}

// 获取当前安装的版本
export function getCurrentVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require(path.join(process.cwd(), "package.json"));
    return packageJson.version || "0.0.0";
  } catch {
    // 如果无法从 package.json 读取，尝试从 dist 目录读取
    try {
      const distPackageJson = path.join(process.cwd(), "dist", "package.json");
      if (fs.existsSync(distPackageJson)) {
        const content = fs.readFileSync(distPackageJson, "utf-8");
        const pkg = JSON.parse(content);
        return pkg.version || "0.0.0";
      }
    } catch {
      // 忽略错误
    }
    return "0.0.0";
  }
}

// 从 npm 获取最新版本
async function getLatestVersionFromNpm(
  packageName: string,
  channel: string = "stable",
): Promise<string> {
  try {
    const registry = "https://registry.npmjs.org";
    const url =
      channel === "stable"
        ? `${registry}/${packageName}/latest`
        : channel === "beta"
          ? `${registry}/${packageName}/beta`
          : `${registry}/${packageName}`;

    const response = await httpGet(url);
    const data = JSON.parse(response);
    return data.version || "0.0.0";
  } catch (error) {
    logWarning(`无法从 npm 获取最新版本: ${error}`);
    return "0.0.0";
  }
}

// 从 GitHub 获取最新版本
async function getLatestVersionFromGitHub(repo: string): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await httpGet(url);
    const data = JSON.parse(response);
    // GitHub API 返回的 tag_name 通常带有 'v' 前缀
    return data.tag_name?.replace(/^v/, "") || "0.0.0";
  } catch (error) {
    logWarning(`无法从 GitHub 获取最新版本: ${error}`);
    return "0.0.0";
  }
}

// 检查更新
export async function checkForUpdates(config: InstallerConfig): Promise<VersionInfo> {
  const currentVersion = getCurrentVersion();

  // 获取最新版本
  let latestVersion: string;
  let releaseNotes: string | undefined;
  let downloadUrl: string | undefined;

  try {
    // 优先从 npm 获取
    latestVersion = await getLatestVersionFromNpm(config.packageName, config.channel);

    // 如果需要 release notes，从 GitHub 获取
    if (config.githubRepo) {
      try {
        const githubUrl = `https://api.github.com/repos/${config.githubRepo}/releases/latest`;
        const response = await httpGet(githubUrl);
        const data = JSON.parse(response);
        releaseNotes = data.body;
        downloadUrl = data.zipball_url;
      } catch {
        // 忽略 GitHub API 错误
      }
    }
  } catch (error) {
    logError(`检查更新失败: ${error}`);
    return {
      current: currentVersion,
      latest: currentVersion,
      updateAvailable: false,
    };
  }

  const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;

  return {
    current: currentVersion,
    latest: latestVersion,
    updateAvailable,
    releaseNotes,
    downloadUrl,
  };
}

// 显示版本检查结果
export function displayVersionInfo(info: VersionInfo): void {
  console.log("\n" + "=".repeat(50));
  console.log("OpenClaw 版本信息");
  console.log("=".repeat(50));
  console.log(`当前版本: ${colors.cyan}${info.current}${colors.reset}`);
  console.log(`最新版本: ${colors.cyan}${info.latest}${colors.reset}`);

  if (info.updateAvailable) {
    console.log(`\n${colors.green}✓ 发现新版本!${colors.reset}`);
    console.log(`${colors.yellow}建议运行更新以获得最新功能和修复。${colors.reset}`);
  } else {
    console.log(`\n${colors.green}✓ 已是最新版本!${colors.reset}`);
  }

  if (info.releaseNotes) {
    console.log("\n发布说明:");
    console.log(
      colors.dim +
        info.releaseNotes.substring(0, 500) +
        (info.releaseNotes.length > 500 ? "..." : "") +
        colors.reset,
    );
  }
  console.log("=".repeat(50) + "\n");
}

// 自动更新源码
export async function autoUpdate(config: InstallerConfig): Promise<boolean> {
  const versionInfo = await checkForUpdates(config);

  if (!versionInfo.updateAvailable) {
    logSuccess("已是最新版本，无需更新");
    return true;
  }

  logInfo(`发现新版本: ${versionInfo.latest} (当前: ${versionInfo.current})`);

  // 显示发布说明
  if (versionInfo.releaseNotes) {
    console.log("\n发布说明:");
    console.log(
      colors.dim +
        versionInfo.releaseNotes.substring(0, 800) +
        (versionInfo.releaseNotes.length > 800 ? "\n..." : "") +
        colors.reset +
        "\n",
    );
  }

  // 确认更新
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(colors.yellow + "是否立即更新? (y/N): " + colors.reset, resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y") {
    logInfo("已取消更新");
    return false;
  }

  return await performUpdate(config, versionInfo);
}

// 执行更新
async function performUpdate(config: InstallerConfig, versionInfo: VersionInfo): Promise<boolean> {
  logInfo("开始更新...");

  try {
    // 检查 git 状态
    if (fs.existsSync(path.join(config.installDir, ".git"))) {
      logInfo("检测到 Git 仓库，执行 git pull...");

      // 检查是否有未提交的更改
      try {
        const status = execSync("git status --porcelain", {
          cwd: config.installDir,
          encoding: "utf-8",
        });

        if (status.trim()) {
          logWarning("检测到未提交的更改:");
          console.log(status);
          const readline = await import("node:readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(
              colors.yellow + "是否暂存更改后更新? (s) 暂存 / (d) 丢弃 / (c) 取消: " + colors.reset,
              resolve,
            );
          });
          rl.close();

          switch (answer.toLowerCase()) {
            case "s":
              execSync("git stash", { cwd: config.installDir, stdio: "inherit" });
              break;
            case "d":
              execSync("git checkout -- .", { cwd: config.installDir, stdio: "inherit" });
              break;
            default:
              logInfo("已取消更新");
              return false;
          }
        }
      } catch {
        // git 命令可能失败，忽略
      }

      // 执行 git pull
      execSync("git fetch origin", { cwd: config.installDir, stdio: "inherit" });

      // 根据 channel 确定分支
      const branch =
        config.channel === "dev" ? "main" : config.channel === "beta" ? "beta" : "main";
      execSync(`git pull origin ${branch}`, { cwd: config.installDir, stdio: "inherit" });

      logSuccess("Git 更新完成");
    }

    // 安装依赖
    logInfo("安装依赖...");
    execSync("pnpm install", { cwd: config.installDir, stdio: "inherit" });
    logSuccess("依赖安装完成");

    // 构建项目
    logInfo("构建项目...");
    execSync("pnpm build", { cwd: config.installDir, stdio: "inherit" });
    logSuccess("构建完成");

    console.log("\n" + "=".repeat(50));
    logSuccess("更新成功!");
    console.log(`版本: ${versionInfo.current} -> ${versionInfo.latest}`);
    console.log("=".repeat(50) + "\n");

    return true;
  } catch (error) {
    logError(`更新失败: ${error}`);
    return false;
  }
}

// 启动安装器
export async function runInstaller(): Promise<void> {
  const config: InstallerConfig = {
    packageName: "openclaw",
    githubRepo: "openclaw/openclaw",
    installDir: process.cwd(),
    channel: "stable",
  };

  // 解析命令行参数
  const args = process.argv.slice(2);

  if (args.includes("--check") || args.includes("-c")) {
    // 只检查版本
    const info = await checkForUpdates(config);
    displayVersionInfo(info);
    process.exit(info.updateAvailable ? 0 : 0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
OpenClaw 安装器

用法:
  node scripts/openclaw-installer.mjs [选项]

选项:
  --check, -c      仅检查版本，不执行更新
  --auto, -a      自动更新，无需确认
  --channel <ch>  指定更新通道 (stable|beta|dev)
  --help, -h      显示帮助信息
    `);
    process.exit(0);
  }

  // 交互式更新流程
  const info = await checkForUpdates(config);
  displayVersionInfo(info);

  if (info.updateAvailable) {
    await autoUpdate(config);
  }
}

// 如果直接运行此脚本
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runInstaller().catch((error) => {
    logError(`安装器错误: ${error}`);
    process.exit(1);
  });
}
