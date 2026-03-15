#!/usr/bin/env node

/**
 * 蜂巢复活系统 - Watchdog 守护进程
 * 
 * 运行在每台机器上，负责：
 * 1. 启动并监控本机的 openclaw 进程
 * 2. openclaw 挂了自动重启
 * 3. 监听 TCP 端口，接受远程重启指令
 * 4. 提供健康检查接口
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Doctor = require('./doctor');

// ============ 加载配置 ============
const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const myName = process.argv[3] || os.hostname();
const myNode = config.cluster.find(n => n.name === myName);

if (!myNode) {
  console.error(`错误：在配置中找不到节点 "${myName}"`);
  console.error(`可用节点：${config.cluster.map(n => n.name).join(', ')}`);
  console.error(`用法：node watchdog.js config.json <节点名>`);
  process.exit(1);
}

const SECRET = myNode.secret;
const OC = config.openclaw;
const doctor = new Doctor(config, (level, msg) => log(level, msg));

// ============ 状态 ============
let childProcess = null;
let childRunning = false;
let restartCount = 0;
let restartTimestamps = [];
let lastExitCode = null;
let lastExitTime = null;
let startTime = null;
let manualStop = false;

// ============ 日志 ============
const LOG_DIR = path.join(os.homedir(), '.hive', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const logStream = fs.createWriteStream(
  path.join(LOG_DIR, 'watchdog.log'),
  { flags: 'a' }
);

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ============ 核心：启动 openclaw ============
function startOpenClaw() {
  if (childRunning) {
    log('WARN', 'openclaw 已在运行，跳过启动');
    return;
  }

  if (manualStop) {
    log('INFO', '手动停止模式，不自动启动');
    return;
  }

  // 检查重启频率（防止疯狂重启）
  const now = Date.now();
  restartTimestamps = restartTimestamps.filter(
    t => now - t < OC.maxRestartWindow
  );

  if (restartTimestamps.length >= OC.maxRestarts) {
    log('ERROR', `${OC.maxRestartWindow / 1000}秒内重启了${OC.maxRestarts}次，暂停自动重启`);
    log('ERROR', '需要人工介入或远程发送 force-restart 指令');
    return;
  }

  restartTimestamps.push(now);
  restartCount++;

  log('INFO', `启动 openclaw (第${restartCount}次)...`);
  log('INFO', `命令：${OC.command} ${OC.args.join(' ')}`);

  try {
    childProcess = spawn(OC.command, OC.args, {
      cwd: OC.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' }
    });

    childRunning = true;
    startTime = Date.now();

    childProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        log('CLAW', line);
      }
    });

    childProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        log('CLAW-ERR', line);
      }
    });

    childProcess.on('exit', (code, signal) => {
      childRunning = false;
      lastExitCode = code;
      lastExitTime = Date.now();
      childProcess = null;

      log('WARN', `openclaw 退出：code=${code} signal=${signal}`);

      if (!manualStop) {
        log('INFO', `${OC.restartDelay / 1000}秒后重启...`);
        setTimeout(() => startOpenClaw(), OC.restartDelay);
      }
    });

    childProcess.on('error', (err) => {
      childRunning = false;
      childProcess = null;
      log('ERROR', `openclaw 启动失败：${err.message}`);

      if (!manualStop) {
        log('INFO', `${OC.restartDelay / 1000}秒后重试...`);
        setTimeout(() => startOpenClaw(), OC.restartDelay);
      }
    });

    log('INFO', `openclaw 已启动，PID: ${childProcess.pid}`);
  } catch (err) {
    log('ERROR', `启动异常：${err.message}`);
    childRunning = false;

    if (!manualStop) {
      setTimeout(() => startOpenClaw(), OC.restartDelay);
    }
  }
}

// ============ 核心：停止 openclaw ============
function stopOpenClaw(force = false) {
  if (!childProcess) {
    log('INFO', 'openclaw 未在运行');
    return;
  }

  log('INFO', `停止 openclaw (PID: ${childProcess.pid})${force ? ' [强制]' : ''}...`);

  if (force) {
    childProcess.kill('SIGKILL');
  } else {
    childProcess.kill('SIGTERM');

    setTimeout(() => {
      if (childRunning && childProcess) {
        log('WARN', 'SIGTERM 超时，强制杀死');
        childProcess.kill('SIGKILL');
      }
    }, 10000);
  }
}

// ============ 健康检查 ============
function healthCheck() {
  if (!OC.healthCheckUrl) return;
  if (!childRunning) return;

  const url = new URL(OC.healthCheckUrl);

  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      timeout: 5000
    },
    (res) => {
      if (res.statusCode === 200) {
        // 健康
      } else {
        log('WARN', `健康检查失败：HTTP ${res.statusCode}`);
        handleUnhealthy();
      }
    }
  );

  req.on('error', (err) => {
    log('WARN', `健康检查错误：${err.message}`);
    handleUnhealthy();
  });

  req.on('timeout', () => {
    log('WARN', '健康检查超时');
    req.destroy();
    handleUnhealthy();
  });

  req.end();
}

let unhealthyCount = 0;

function handleUnhealthy() {
  unhealthyCount++;
  if (unhealthyCount >= 3) {
    log('ERROR', '连续 3 次健康检查失败，重启 openclaw');
    unhealthyCount = 0;
    stopOpenClaw();
  }
}

// ============ 认证：HMAC 签名验证 ============
function createAuthToken(timestamp, action) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}:${action}`)
    .digest('hex');
}

function verifyAuth(timestamp, action, token) {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 30) {
    return false;
  }
  const expected = createAuthToken(timestamp, action);
  const expectedBuf = Buffer.from(expected);
  const tokenBuf = Buffer.from(token);
  // timingSafeEqual requires identical buffer lengths
  if (expectedBuf.length !== tokenBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

// ============ TCP 指令服务器 ============
const tcpServer = net.createServer((conn) => {
  const remoteAddr = `${conn.remoteAddress}:${conn.remotePort}`;
  log('INFO', `TCP 连接：${remoteAddr}`);

  let buffer = '';

  conn.on('data', (data) => {
    buffer += data.toString();

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const cmd = JSON.parse(line);
        handleRemoteCommand(cmd, conn, remoteAddr);
      } catch (err) {
        conn.write(
          JSON.stringify({ ok: false, error: '无效 JSON' }) + '\n'
        );
      }
    }
  });

  conn.on('error', () => {});

  conn.setTimeout(30000, () => {
    conn.end();
  });
});

function handleRemoteCommand(cmd, conn, remoteAddr) {
  if (!cmd.timestamp || !cmd.action || !cmd.token) {
    conn.write(
      JSON.stringify({ ok: false, error: '缺少认证字段' }) + '\n'
    );
    return;
  }

  if (!verifyAuth(cmd.timestamp, cmd.action, cmd.token)) {
    log('WARN', `认证失败：${remoteAddr} action=${cmd.action}`);
    conn.write(
      JSON.stringify({ ok: false, error: '认证失败' }) + '\n'
    );
    return;
  }

  log('INFO', `远程指令：${cmd.action} from ${remoteAddr}`);

  let response;

  switch (cmd.action) {
    case 'status':
      response = { ok: true, data: getStatus() };
      break;

    case 'restart':
      manualStop = false;
      stopOpenClaw();
      response = { ok: true, message: '重启指令已发送' };
      break;

    case 'diagnose-and-repair':
      // 执行完整诊断修复流程
      (async () => {
        log('INFO', '开始诊断修复流程...');
        const result = await doctor.diagnoseAndRepair();
        log('INFO', `诊断完成：健康状态=${result.overallHealthy}`);
        log('INFO', `修复项目：${result.repairs.length}`);
        
        // 修复完成后重启
        if (result.repairs.length > 0) {
          log('INFO', '修复完成，准备重启 openclaw...');
          manualStop = false;
          stopOpenClaw();
          setTimeout(() => startOpenClaw(), 5000);
        }
      })();
      response = { ok: true, message: '诊断修复流程已启动' };
      break;

    case 'force-restart':
      manualStop = false;
      restartTimestamps = [];
      stopOpenClaw(true);
      setTimeout(() => startOpenClaw(), 2000);
      response = { ok: true, message: '强制重启指令已发送' };
      break;

    case 'stop':
      manualStop = true;
      stopOpenClaw();
      response = { ok: true, message: '停止指令已发送' };
      break;

    case 'start':
      manualStop = false;
      startOpenClaw();
      response = { ok: true, message: '启动指令已发送' };
      break;

    case 'ping':
      response = { ok: true, message: 'pong', timestamp: Date.now() };
      break;

    default:
      response = { ok: false, error: `未知指令：${cmd.action}` };
  }

  conn.write(JSON.stringify(response) + '\n');
}

function getStatus() {
  return {
    node: myName,
    openclawRunning: childRunning,
    openclawPid: childProcess ? childProcess.pid : null,
    uptime: childRunning && startTime ? Date.now() - startTime : 0,
    restartCount,
    lastExitCode,
    lastExitTime: lastExitTime ? new Date(lastExitTime).toISOString() : null,
    manualStop,
    memoryUsage: process.memoryUsage().rss,
    watchdogUptime: Math.floor(process.uptime())
  };
}

// ============ 启动一切 ============
log('INFO', '========================================');
log('INFO', `Watchdog 启动：节点=${myName}`);
log('INFO', `监听端口：${myNode.watchdogPort}`);
log('INFO', '========================================');

tcpServer.listen(myNode.watchdogPort, '0.0.0.0', () => {
  log('INFO', `TCP 指令服务器启动在端口 ${myNode.watchdogPort}`);
});

startOpenClaw();

if (OC.healthCheckUrl) {
  setInterval(() => healthCheck(), OC.healthCheckInterval);
}

process.on('SIGINT', () => {
  log('INFO', 'Watchdog 收到 SIGINT，关闭中...');
  manualStop = true;
  stopOpenClaw();
  tcpServer.close();
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', () => {
  log('INFO', 'Watchdog 收到 SIGTERM，关闭中...');
  manualStop = true;
  stopOpenClaw();
  tcpServer.close();
  setTimeout(() => process.exit(0), 3000);
});

process.on('uncaughtException', (err) => {
  log('FATAL', `未捕获异常：${err.message}\n${err.stack}`);
});
