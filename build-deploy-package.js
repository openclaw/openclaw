#!/usr/bin/env node
/**
 * build-deploy-package.js - OpenClaw 二次开发打包脚本（Node.js 版本）
 * 修复：将八进制 \033 替换为十六进制 \x1b，解决 TS 八进制转义报错
 * 新增：复制根目录下的 deploy.js 文件到打包目录
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ===================== 配置项（可根据需求修改）=====================
const config = {
  DEPLOY_DIR: './openclaw-deploy',  // 打包输出目录
  BUILD_DIR: './dist',              // 编译产物目录
  ENTRY_FILE: './openclaw.mjs',     // 主入口文件
  PACKAGE_JSON: './package.json',   // 依赖描述文件
  PM2_CONFIG: './ecosystem.config.js', // 本地pm2配置文件
  DEPLOY_JS: './deploy.js'          // 新增：根目录下的deploy.js文件路径
};

// ===================== 工具函数（修复颜色转义符）=====================
// 替换八进制 \033 为十六进制 \x1b，解决 TS 报错
const logger = {
  info: (msg) => console.log(`${'\x1b[34m'}🔍 ${msg}${'\x1b[0m'}`),    // 蓝色
  success: (msg) => console.log(`${'\x1b[32m'}✅ ${msg}${'\x1b[0m'}`),  // 绿色
  error: (msg) => console.log(`${'\x1b[31m'}❌ ${msg}${'\x1b[0m'}`),    // 红色
  warn: (msg) => console.log(`${'\x1b[33m'}🔨 ${msg}${'\x1b[0m'}`)     // 黄色
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

// 执行命令并捕获错误
function runCommand(cmd, errorMsg) {
  try {
    execSync(cmd, { stdio: 'inherit', encoding: 'utf8' });
  } catch (err) {
    logger.error(errorMsg);
    process.exit(1);
  }
}

// ===================== 核心逻辑 =====================
async function main() {
  try {
    // 1. 清理旧产物
    logger.info('清理旧打包产物...');
    deleteDir(config.DEPLOY_DIR);
    fs.mkdirSync(config.DEPLOY_DIR, { recursive: true });

    // 2. 编译源码（确保最新）
    logger.warn('编译二次开发源码...');
    runCommand('pnpm build', '源码编译失败，请检查代码！');

    // 3. 复制核心文件
    logger.info('复制运行必需文件...');
    
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

    // 3.5 新增：复制deploy.js文件
    if (fs.existsSync(config.DEPLOY_JS)) {
      fs.copyFileSync(config.DEPLOY_JS, path.join(config.DEPLOY_DIR, path.basename(config.DEPLOY_JS)));
      logger.info(`已复制 deploy.js 文件到打包目录`);
    } else {
      logger.error(`未找到部署脚本文件：${config.DEPLOY_JS}，请先创建！`);
      process.exit(1);
    }

    // 4. 生成打包清单
    logger.info('生成打包清单...');
    const deployFiles = fs.readdirSync(config.DEPLOY_DIR);
    const fileListContent = deployFiles.map(file => {
      const stats = fs.statSync(path.join(config.DEPLOY_DIR, file));
      const size = (stats.size / 1024).toFixed(2) + 'KB';
      return `${file} | ${stats.isDirectory() ? '目录' : '文件'} | ${size}`;
    }).join('\n');
    fs.writeFileSync(path.join(config.DEPLOY_DIR, 'deploy-files.txt'), fileListContent, 'utf8');

    // 5. 完成提示
    logger.success('打包完成！');
    console.log(`📂 打包目录：${path.resolve(config.DEPLOY_DIR)}`);
    console.log('🚀 下一步：将该目录上传到服务器（如 /opt/openclaw），执行 deploy.js 部署');

  } catch (err) {
    logger.error(`打包过程出错：${err.message}`);
    process.exit(1);
  }
}

// 启动脚本
main();
