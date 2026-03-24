#!/usr/bin/env node
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ===================== 配置项（可根据需求修改）=====================
const CONFIG = {
  DEPLOY_PATH: '/opt/openclaw',    // 服务器部署根目录
  GATEWAY_PORT: 18789,             // 网关端口
  DASHBOARD_PORT: 3000,            // UI端口
  NODE_MIN_VERSION: '24.0.0',      // 最低Node版本要求
  PM2_PROCESS_NAME: 'openclaw',    // pm2进程前缀
  PM2_CONFIG_FILE: 'ecosystem.config.js' // pm2配置文件名
};

// ===================== 颜色输出函数 =====================
const color = {
  red: (text) => `\x1B[31m${text}\x1B[0m`,
  green: (text) => `\x1B[32m${text}\x1B[0m`,
  yellow: (text) => `\x1B[33m${text}\x1B[0m`,
  blue: (text) => `\x1B[34m${text}\x1B[0m`
};

// ===================== 工具函数 =====================
/**
 * 执行shell命令（同步）
 * @param {string} cmd 命令
 * @param {boolean} silent 是否静默执行（不输出错误）
 * @returns {string} 命令输出
 */
function execCmd(cmd, silent = false) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
  } catch (e) {
    if (!silent) console.error(color.red(`❌ 命令执行失败: ${cmd}`));
    throw e;
  }
}

/**
 * 版本对比（是否大于等于）
 * @param {string} v1 待比较版本
 * @param {string} v2 基准版本
 * @returns {boolean}
 */
function versionGe(v1, v2) {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);
  const maxLen = Math.max(v1Parts.length, v2Parts.length);

  for (let i = 0; i < maxLen; i++) {
    const num1 = v1Parts[i] || 0;
    const num2 = v2Parts[i] || 0;
    if (num1 > num2) return true;
    if (num1 < num2) return false;
  }
  return true; // 版本相同
}

/**
 * 检查端口是否被占用并释放
 * @param {number} port 端口号
 */
function checkAndFreePort(port) {
  console.log(color.blue(`🔍 检查端口 ${port} 占用情况...`));
  try {
    // 检查端口占用
    const output = execCmd(`lsof -i:${port}`, true);
    if (output) {
      console.log(color.yellow(`⚠️ 端口 ${port} 已被占用，尝试杀死占用进程...`));
      execCmd(`lsof -ti:${port} | xargs kill -9`);
    }
  } catch (e) {
    // 端口未被占用时lsof会报错，忽略
  }
}

/**
 * 获取本机IP地址
 * @returns {string}
 */
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

// ===================== 主流程 =====================
async function main() {
  try {
    // 1. 检查Root权限
    console.log(color.blue('🔍 检查Root权限...'));
    const euid = process.geteuid ? process.geteuid() : -1;
    if (euid !== 0) {
      console.error(color.red('❌ 请使用root权限运行脚本（sudo node deploy.js）'));
      process.exit(1);
    }
    console.log(color.green('✅ Root权限验证通过'));

    // 2. 检查Node.js版本
    console.log(color.blue('🔍 检查Node.js版本...'));
    let nodeVersion;
    try {
      nodeVersion = execCmd('node -v', true).replace('v', '').trim();
    } catch (e) {
      console.log(color.yellow('⚠️ 未安装Node.js，开始安装（Node 24 LTS）...'));
      execCmd('curl -fsSL https://deb.nodesource.com/setup_24.x | bash -');
      execCmd('apt-get install -y nodejs');
      nodeVersion = execCmd('node -v', true).replace('v', '').trim();
    }

    if (!versionGe(nodeVersion, CONFIG.NODE_MIN_VERSION)) {
      console.error(color.red(`❌ Node.js版本过低（当前：${nodeVersion}，要求≥${CONFIG.NODE_MIN_VERSION}）`));
      console.error(color.red(`💡 建议手动安装Node 24 LTS：curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs`));
      process.exit(1);
    }
    console.log(color.green(`✅ Node.js版本符合要求：${nodeVersion}`));

    // 3. 安装pnpm
    console.log(color.blue('🔍 检查pnpm...'));
    try {
      execCmd('pnpm -v', true);
    } catch (e) {
      console.log(color.yellow('⚠️ 未安装pnpm，开始安装...'));
      execCmd('npm install -g pnpm');
    }
    const pnpmVersion = execCmd('pnpm -v', true).trim();
    console.log(color.green(`✅ pnpm已安装：${pnpmVersion}`));

    // 4. 安装pm2
    console.log(color.blue('🔍 检查pm2...'));
    try {
      execCmd('pm2 -v', true);
    } catch (e) {
      console.log(color.yellow('⚠️ 未安装pm2，开始安装...'));
      execCmd('npm install -g pm2');
    }
    const pm2Version = execCmd('pm2 -v', true).trim();
    console.log(color.green(`✅ pm2已安装：${pm2Version}`));

    // 5. 创建部署目录
    console.log(color.blue('📁 准备部署目录...'));
    const deployPath = CONFIG.DEPLOY_PATH;
    const logsPath = path.join(deployPath, 'logs');
    
    if (!fs.existsSync(deployPath)) {
      fs.mkdirSync(deployPath, { recursive: true });
    }
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }

    // 备份旧配置
    const configFile = path.join(deployPath, 'openclaw.json');
    if (fs.existsSync(configFile)) {
      const timestamp = new Date().toISOString().replace(/[-:\.T]/g, '').slice(0, 14);
      const backupFile = `${configFile}.bak.${timestamp}`;
      fs.copyFileSync(configFile, backupFile);
      console.log(color.yellow(`⚠️ 已备份旧配置文件：${backupFile}`));
    }

    // 6. 复制部署文件
    console.log(color.blue(`📥 复制部署文件到 ${deployPath}...`));
    // 复制当前目录所有文件到部署目录（模拟cp -r ./*）
    execCmd(`cp -r ./* ${deployPath}/`);
    process.chdir(deployPath);

    // 检查pm2配置文件
    const pm2ConfigFile = path.join(deployPath, CONFIG.PM2_CONFIG_FILE);
    if (!fs.existsSync(pm2ConfigFile)) {
      console.error(color.red(`❌ 服务器部署目录未找到pm2配置文件：${CONFIG.PM2_CONFIG_FILE}`));
      process.exit(1);
    }

    // 7. 安装生产依赖
    console.log(color.blue('📦 安装生产依赖...'));
    try {
      execCmd('pnpm install --production');
    } catch (e) {
      console.error(color.red('❌ 依赖安装失败！'));
      process.exit(1);
    }
    console.log(color.green('✅ 依赖安装完成'));

    // 8. 检查端口占用
    console.log(color.blue('🔌 检查端口占用...'));
    checkAndFreePort(CONFIG.GATEWAY_PORT);
    checkAndFreePort(CONFIG.DASHBOARD_PORT);
    console.log(color.green(`✅ 端口 ${CONFIG.GATEWAY_PORT}/${CONFIG.DASHBOARD_PORT} 已就绪`));

    // 9. 启动服务
    console.log(color.blue('🚀 启动OpenClaw网关和UI...'));
    // 停止旧进程
    try {
      execCmd(`pm2 delete ${CONFIG.PM2_PROCESS_NAME}-gateway ${CONFIG.PM2_PROCESS_NAME}-dashboard`, true);
    } catch (e) {
      // 进程不存在时忽略错误
    }
    // 启动新进程
    execCmd(`pm2 start ${CONFIG.PM2_CONFIG_FILE}`);
    try {
      execCmd('pm2 save');
    } catch (e) {
      console.log(color.yellow('⚠️ pm2开机自启配置失败（可手动执行 pm2 startup）'));
    }

    // 10. 校验服务状态
    console.log(color.blue('🔍 校验服务状态...'));
    // 等待服务启动
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 读取pm2配置中的进程名
    const pm2ConfigContent = fs.readFileSync(pm2ConfigFile, 'utf8');
    const nameMatches = pm2ConfigContent.match(/"name":\s*"([^"]+)"/g) || [];
    const GATEWAY_NAME = nameMatches[0]?.split('"')[3] || `${CONFIG.PM2_PROCESS_NAME}-gateway`;
    const DASHBOARD_NAME = nameMatches[1]?.split('"')[3] || `${CONFIG.PM2_PROCESS_NAME}-dashboard`;

    // 检查网关状态
    try {
      const gatewayStatus = execCmd(`pm2 status ${GATEWAY_NAME}`, true);
      if (gatewayStatus.includes('online')) {
        console.log(color.green('✅ 网关服务启动成功！'));
      } else {
        throw new Error('网关服务未在线');
      }
    } catch (e) {
      console.error(color.red('❌ 网关服务启动失败，日志：'));
      const gatewayLog = path.join(deployPath, 'logs', 'gateway-err.log');
      if (fs.existsSync(gatewayLog)) {
        console.log(fs.readFileSync(gatewayLog, 'utf8'));
      }
      process.exit(1);
    }

    // 检查UI状态
    try {
      const dashboardStatus = execCmd(`pm2 status ${DASHBOARD_NAME}`, true);
      if (dashboardStatus.includes('online')) {
        console.log(color.green('✅ UI服务启动成功！'));
      } else {
        throw new Error('UI服务未在线');
      }
    } catch (e) {
      console.error(color.red('❌ UI服务启动失败，日志：'));
      const dashboardLog = path.join(deployPath, 'logs', 'dashboard-err.log');
      if (fs.existsSync(dashboardLog)) {
        console.log(fs.readFileSync(dashboardLog, 'utf8'));
      }
      process.exit(1);
    }

    // 11. 完成提示
    console.log(color.green('\n🎉 部署完成！'));
    const localIp = getLocalIp();
    console.log(color.blue(`🔗 网关地址：http://${localIp}:${CONFIG.GATEWAY_PORT}`));
    console.log(color.blue(`🖥️ UI地址：http://${localIp}:${CONFIG.DASHBOARD_PORT}`));
    console.log(color.yellow('💡 常用命令：'));
    console.log(color.yellow(`  - 查看状态：pm2 status`));
    console.log(color.yellow(`  - 查看日志：pm2 logs ${GATEWAY_NAME} -f`));
    console.log(color.yellow(`  - 重启服务：pm2 restart ${pm2ConfigFile}`));

  } catch (error) {
    console.error(color.red(`❌ 部署过程出错：${error.message}`));
    process.exit(1);
  }
}

// 执行主流程
main();
