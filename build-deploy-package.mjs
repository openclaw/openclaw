#!/usr/bin/env node
/**
 * build-deploy-package.js - OpenClaw 打包脚本（ES 模块版，适配 package.json "type": "module"）
 * 修复：CommonJS → ES 模块，解决 require is not defined 报错
 * 功能：Node版本校验 + pnpm自动安装 + 生产依赖安装 + 双构建命令 + 文件复制
 */

import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

// 适配 ES 模块的异步exec
const execAsync = promisify(exec);

// ===================== 配置项（可根据需求修改）=====================
const config = {
  DEPLOY_DIR: './openclaw-deploy',  // 打包输出目录
  BUILD_DIR: './dist',              // 编译产物目录
  ENTRY_FILE: './openclaw.mjs',     // 主入口文件
  PACKAGE_JSON: './package.json',   // 依赖描述文件
  PM2_CONFIG: './ecosystem.config.js', // 本地pm2配置文件
  DEPLOY_JS: './deploy.mjs',         // 根目录下的deploy.js文件路径
  MIN_NODE_VERSION: '24.0.0'        // 最低Node.js版本要求
};

// ===================== 工具函数（修复颜色转义符）=====================
const logger = {
  info: (msg) => console.log(`${'\x1b[34m'}🔍 ${msg}${'\x1b[0m'}`),    // 蓝色
  success: (msg) => console.log(`${'\x1b[32m'}✅ ${msg}${'\x1b[0m'}`),  // 绿色
  error: (msg) => console.log(`${'\x1b[31m'}❌ ${msg}${'\x1b[0m'}`),    // 红色
  warn: (msg) => console.log(`${'\x1b[33m'}🔨 ${msg}${'\x1b[0m'}`),     // 黄色
  title: (msg) => console.log(`${'\x1b[35m'}📌 ${msg}${'\x1b[0m'}`)    // 紫色（标题）
};

// 递归删除目录（兼容跨平台）
function deleteDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach(file => {
      const curPath = path.join(dirPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        deleteDir(curPath);
      } else {
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(dirPath);
  }
}

// 执行命令并捕获错误（同步）
function runCommand(cmd, errorMsg) {
  try {
    execSync(cmd, { stdio: 'inherit', encoding: 'utf8' });
  } catch (err) {
    logger.error(errorMsg);
    logger.error(`命令执行失败：${cmd}`);
    process.exit(1);
  }
}

// 版本号比较（a >= b 返回true）
function compareVersion(a, b) {
  const aParts = a.replace(/^v/, '').split('.').map(Number);
  const bParts = b.replace(/^v/, '').split('.').map(Number);
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLen; i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal > bVal) return true;
    if (aVal < bVal) return false;
  }
  return true; // 版本相等
}

// 检查并安装pnpm
async function checkAndInstallPnpm() {
  logger.title('检查pnpm环境...');
  try {
    const { stdout } = await execAsync('pnpm --version', { encoding: 'utf8' });
    logger.success(`pnpm已安装，版本：${stdout.trim()}`);
  } catch (err) {
    logger.warn('未检测到pnpm，开始自动安装...');
    // 全局安装pnpm
    runCommand('npm install -g pnpm', 'pnpm安装失败，请手动执行 npm install -g pnpm 后重试！');
    logger.success('pnpm安装成功！');
  }
}

// 检查Node.js版本
function checkNodeVersion() {
  logger.title('检查Node.js版本...');
  const currentVersion = process.version;
  logger.info(`当前Node.js版本：${currentVersion}`);

  if (compareVersion(currentVersion, config.MIN_NODE_VERSION)) {
    logger.success(`Node.js版本满足要求（≥${config.MIN_NODE_VERSION}）`);
    return true;
  }

  logger.error(`Node.js版本过低！当前版本：${currentVersion}，要求最低版本：${config.MIN_NODE_VERSION}`);
  logger.warn('请手动升级Node.js：');
  logger.warn('1. 使用nvm安装：nvm install 24 && nvm use 24');
  logger.warn('2. 或直接下载：https://nodejs.org/zh-cn/download/releases/');
  process.exit(1);
}

// 安装生产依赖
function installProdDependencies() {
  logger.title('安装生产依赖...');
  if (!fs.existsSync(config.PACKAGE_JSON)) {
    logger.error(`未找到package.json文件：${config.PACKAGE_JSON}`);
    process.exit(1);
  }
  // 仅安装生产依赖（--prod），加快安装速度
  runCommand('pnpm install', '生产依赖安装失败，请检查网络或package.json！');
  logger.success('生产依赖安装完成！');
}

// 执行构建命令（build + ui:build）
function runBuildCommands() {
  logger.title('执行项目构建...');
  // 执行主构建命令
  logger.info('执行 pnpm build...');
  runCommand('pnpm build', 'pnpm build 执行失败，请检查代码错误！');
  
  // 执行UI构建命令
  logger.info('执行 pnpm ui:build...');
  runCommand('pnpm ui:build', 'pnpm ui:build 执行失败，请检查UI代码错误！');
  
  logger.success('所有构建命令执行完成！');
}

// 复制核心文件到打包目录
function copyCoreFiles() {
  logger.title('复制运行必需文件...');
  
  // 3.1 复制主入口文件
  if (fs.existsSync(config.ENTRY_FILE)) {
    fs.copyFileSync(config.ENTRY_FILE, path.join(config.DEPLOY_DIR, path.basename(config.ENTRY_FILE)));
  } else {
    logger.error(`未找到主入口文件：${config.ENTRY_FILE}`);
    process.exit(1);
  }

  // 3.2 复制编译产物目录
  if (fs.existsSync(config.BUILD_DIR)) {
    const targetBuildDir = path.join(config.DEPLOY_DIR, path.basename(config.BUILD_DIR));
    fs.cpSync(config.BUILD_DIR, targetBuildDir, { recursive: true });
  } else {
    logger.error(`未找到编译产物目录：${config.BUILD_DIR}`);
    process.exit(1);
  }

  // 3.3 复制package.json
  if (fs.existsSync(config.PACKAGE_JSON)) {
    fs.copyFileSync(config.PACKAGE_JSON, path.join(config.DEPLOY_DIR, path.basename(config.PACKAGE_JSON)));
  } else {
    logger.error(`未找到依赖描述文件：${config.PACKAGE_JSON}`);
    process.exit(1);
  }

  // 3.4 复制pm2配置文件
  if (fs.existsSync(config.PM2_CONFIG)) {
    fs.copyFileSync(config.PM2_CONFIG, path.join(config.DEPLOY_DIR, path.basename(config.PM2_CONFIG)));
  } else {
    logger.error(`未找到pm2配置文件：${config.PM2_CONFIG}，请先创建！`);
    process.exit(1);
  }

  // 3.5 复制deploy.js文件
  if (fs.existsSync(config.DEPLOY_JS)) {
    fs.copyFileSync(config.DEPLOY_JS, path.join(config.DEPLOY_DIR, path.basename(config.DEPLOY_JS)));
    logger.info(`已复制 deploy.js 文件到打包目录`);
  } else {
    logger.error(`未找到部署脚本文件：${config.DEPLOY_JS}，请先创建！`);
    process.exit(1);
  }

  logger.success('核心文件复制完成！');
}

// 生成打包清单
function generateDeployList() {
  logger.title('生成打包清单...');
  const deployFiles = fs.readdirSync(config.DEPLOY_DIR);
  const fileListContent = deployFiles.map(file => {
    const stats = fs.statSync(path.join(config.DEPLOY_DIR, file));
    const size = (stats.size / 1024).toFixed(2) + 'KB';
    return `${file} | ${stats.isDirectory() ? '目录' : '文件'} | ${size}`;
  }).join('\n');
  fs.writeFileSync(path.join(config.DEPLOY_DIR, 'deploy-files.txt'), fileListContent, 'utf8');
  logger.success('打包清单生成完成！');
}

// ===================== 核心逻辑 =====================
async function main() {
  try {
    // 1. 前置环境检查
    checkNodeVersion(); // 检查Node版本
    await checkAndInstallPnpm(); // 检查并安装pnpm
    
    // 2. 安装生产依赖
    installProdDependencies();

    // 3. 执行构建命令
    runBuildCommands();

    // 4. 清理旧产物
    logger.title('清理旧打包产物...');
    deleteDir(config.DEPLOY_DIR);
    fs.mkdirSync(config.DEPLOY_DIR, { recursive: true });
    logger.success('旧产物清理完成！');

    // 5. 复制核心文件
    copyCoreFiles();

    // 6. 生成打包清单
    generateDeployList();

    // 7. 完成提示
    logger.success('\n🎉 打包全流程完成！');
    console.log(`📂 打包目录：${path.resolve(config.DEPLOY_DIR)}`);
    console.log('🚀 下一步：将该目录上传到服务器（如 /opt/openclaw），执行 deploy.mjs 部署');

  } catch (err) {
    logger.error(`打包过程出错：${err.message}`);
    process.exit(1);
  }
}

// 启动脚本
main();
