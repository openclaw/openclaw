#!/usr/bin/env node

/**
 * 蜂巢复活系统 - 集群监控进程
 * 
 * 运行在每个节点上，定期检查所有其他节点的状态
 * 发现某节点的 openclaw 挂了 → 发送远程重启指令给该节点的 watchdog
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============ 加载配置 ============
const CONFIG_PATH = process.argv[2] || path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const myName = process.argv[3] || os.hostname();
const MON = config.monitor;

// ============ 日志 ============
const LOG_DIR = path.join(os.homedir(), '.hive', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const logStream = fs.createWriteStream(
  path.join(LOG_DIR, 'monitor.log'),
  { flags: 'a' }
);

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ============ 节点状态追踪 ============
const nodeStates = new Map();

for (const node of config.cluster) {
  nodeStates.set(node.name, {
    config: node,
    consecutiveFailures: 0,
    lastStatus: null,
    lastCheck: null,
    recovering: false
  });
}

// ============ 发送指令到远程 watchdog ============
function sendCommand(node, action) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const token = crypto
      .createHmac('sha256', node.secret)
      .update(`${timestamp}:${action}`)
      .digest('hex');

    const cmd = JSON.stringify({ timestamp, action, token }) + '\n';

    const client = net.createConnection(
      { host: node.host, port: node.watchdogPort, timeout: MON.timeout },
      () => {
        client.write(cmd);
      }
    );

    let buffer = '';

    client.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          client.end();
          resolve(response);
          return;
        } catch (e) {
          // 继续接收
        }
      }
    });

    client.on('timeout', () => {
      client.destroy();
      reject(new Error('连接超时'));
    });

    client.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      client.destroy();
      reject(new Error('请求超时'));
    }, MON.timeout);
  });
}

// ============ 检查单个节点 ============
async function checkNode(nodeName) {
  const state = nodeStates.get(nodeName);
  const nodeConfig = state.config;

  if (nodeName === myName) return;

  try {
    const pingResult = await sendCommand(nodeConfig, 'ping');

    if (!pingResult.ok) {
      throw new Error('ping 失败');
    }

    const statusResult = await sendCommand(nodeConfig, 'status');

    if (!statusResult.ok) {
      throw new Error('状态查询失败');
    }

    state.lastStatus = statusResult.data;
    state.lastCheck = Date.now();

    if (statusResult.data.openclawRunning) {
      if (state.consecutiveFailures > 0) {
        log(
          'INFO',
          `节点 ${nodeName} 已恢复正常 (之前失败${state.consecutiveFailures}次)`
        );
      }
      state.consecutiveFailures = 0;
      state.recovering = false;
    } else {
      state.consecutiveFailures++;
      log(
        'WARN',
        `节点 ${nodeName} 的 openclaw 未运行 ` +
          `(连续${state.consecutiveFailures}次检测)`
      );

      if (
        state.consecutiveFailures >= MON.failThreshold &&
        !state.recovering
      ) {
        await triggerRemoteRestart(nodeName, nodeConfig, state);
      }
    }
  } catch (err) {
    state.consecutiveFailures++;
    state.lastCheck = Date.now();

    log(
      'ERROR',
      `无法连接节点 ${nodeName}: ${err.message} ` +
        `(连续${state.consecutiveFailures}次)`
    );

    if (state.consecutiveFailures >= MON.failThreshold * 2) {
      log(
        'FATAL',
        `节点 ${nodeName} 完全失联，可能需要人工介入`
      );
    }
  }
}

// ============ 触发远程重启 ============
async function triggerRemoteRestart(nodeName, nodeConfig, state) {
  const onlineNodes = [];

  for (const [name, s] of nodeStates) {
    if (name === nodeName) continue;
    if (name === myName) {
      onlineNodes.push(name);
      continue;
    }
    if (s.lastStatus && s.lastStatus.openclawRunning) {
      onlineNodes.push(name);
    }
  }

  onlineNodes.sort();

  if (onlineNodes[0] !== myName) {
    log(
      'INFO',
      `节点 ${nodeName} 需要重启，但由 ${onlineNodes[0]} 负责（不是我）`
    );
    return;
  }

  log('INFO', `===== 开始远程重启节点 ${nodeName} =====`);
  state.recovering = true;

  try {
    // 优先使用诊断修复模式
    const result = await sendCommand(nodeConfig, 'diagnose-and-repair');
    log('INFO', `诊断修复指令已发送到 ${nodeName}: ${JSON.stringify(result)}`);

    setTimeout(async () => {
      try {
        const checkResult = await sendCommand(nodeConfig, 'status');
        if (checkResult.ok && checkResult.data.openclawRunning) {
          log('INFO', `节点 ${nodeName} 重启成功！`);
          state.recovering = false;
          state.consecutiveFailures = 0;
        } else {
          log('WARN', `节点 ${nodeName} 普通重启后仍未恢复，尝试强制重启`);

          const forceResult = await sendCommand(
            nodeConfig,
            'force-restart'
          );
          log(
            'INFO',
            `强制重启指令已发送：${JSON.stringify(forceResult)}`
          );
        }
      } catch (err) {
        log('ERROR', `重启后检查失败：${err.message}`);
        state.recovering = false;
      }
    }, 30000);
  } catch (err) {
    log('ERROR', `发送重启指令失败：${err.message}`);
    state.recovering = false;
  }
}

// ============ 主循环 ============
async function monitorLoop() {
  const otherNodes = config.cluster.filter((n) => n.name !== myName);

  if (otherNodes.length === 0) {
    log('WARN', '集群中没有其他节点需要监控');
    return;
  }

  log(
    'INFO',
    `开始检查 ${otherNodes.length} 个节点：${otherNodes.map((n) => n.name).join(', ')}`
  );

  for (const node of otherNodes) {
    await checkNode(node.name);
  }
}

// ============ 启动 ============
log('INFO', '========================================');
log('INFO', `Monitor 启动：我是 ${myName}`);
log('INFO', `检查间隔：${MON.checkInterval / 1000}秒`);
log('INFO', `失败阈值：${MON.failThreshold}次`);
log('INFO', '========================================');

monitorLoop();

setInterval(() => monitorLoop(), MON.checkInterval);

process.on('SIGINT', () => {
  log('INFO', 'Monitor 关闭');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('INFO', 'Monitor 关闭');
  process.exit(0);
});
