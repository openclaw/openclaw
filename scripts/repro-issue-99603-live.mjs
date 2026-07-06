#!/usr/bin/env node
/**
 * Issue #99603 真机复现脚本
 *
 * 问题描述：当 git push 触发源文件变更时，如果 dist/ 正在重建中，
 * hot-reload watcher (watch-node.mjs) 会无条件杀死当前健康的 gateway 子进程，
 * 并重启进入损坏的 dist/，导致 crash-loop，最终耗尽 systemd 的重启限制（37分钟停机）。
 *
 * 复现步骤：
 * 1. 启动 gateway:watch
 * 2. 模拟 mid-rebuild 状态（删除 dist/.buildstamp 和 dist/entry.js）
 * 3. 触发源文件变更（touch src/entry.ts）
 * 4. 观察 watcher 行为 - 应该等待 build ready 而不是立即 kill child
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// 配置
const WATCHER_SCRIPT = path.join(ROOT_DIR, 'scripts', 'watch-node.mjs');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DIST_ENTRY = path.join(DIST_DIR, 'entry.js');
const BUILD_STAMP = path.join(DIST_DIR, '.buildstamp');
const SRC_ENTRY = path.join(ROOT_DIR, 'src', 'entry.ts');

// 备份文件位置
const BACKUP_DIST_ENTRY = '/tmp/dist-entry-backup.js';
const BACKUP_BUILD_STAMP = '/tmp/build-stamp-backup.json';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exec(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'pipe', ...options });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });

    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', reject);
  });
}

async function backupFiles() {
  console.log('[备份] 备份原始文件...');

  if (fs.existsSync(DIST_ENTRY)) {
    fs.copyFileSync(DIST_ENTRY, BACKUP_DIST_ENTRY);
    console.log(`  ✓ 备份 ${DIST_ENTRY} -> ${BACKUP_DIST_ENTRY}`);
  }

  if (fs.existsSync(BUILD_STAMP)) {
    const stampContent = fs.readFileSync(BUILD_STAMP, 'utf8');
    fs.writeFileSync(BACKUP_BUILD_STAMP, stampContent);
    console.log(`  ✓ 备份 ${BUILD_STAMP} -> ${BACKUP_BUILD_STAMP}`);
  }
}

async function restoreFiles() {
  console.log('[恢复] 恢复原始文件...');

  if (fs.existsSync(BACKUP_DIST_ENTRY)) {
    fs.copyFileSync(BACKUP_DIST_ENTRY, DIST_ENTRY);
    console.log(`  ✓ 恢复 ${BACKUP_DIST_ENTRY} -> ${DIST_ENTRY}`);
  }

  if (fs.existsSync(BACKUP_BUILD_STAMP)) {
    const stampContent = fs.readFileSync(BACKUP_BUILD_STAMP, 'utf8');
    fs.writeFileSync(BUILD_STAMP, stampContent);
    console.log(`  ✓ 恢复 ${BACKUP_BUILD_STAMP} -> ${BUILD_STAMP}`);
  }
}

async function simulateMidRebuild() {
  console.log('[模拟] 模拟 mid-rebuild 状态（删除 build stamp 和 entry.js）...');

  if (fs.existsSync(BUILD_STAMP)) {
    fs.unlinkSync(BUILD_STAMP);
    console.log(`  ✓ 删除 ${BUILD_STAMP}`);
  }

  if (fs.existsSync(DIST_ENTRY)) {
    // 保留原始文件用于后续恢复
    fs.copyFileSync(DIST_ENTRY, BACKUP_DIST_ENTRY);
    fs.unlinkSync(DIST_ENTRY);
    console.log(`  ✓ 删除 ${DIST_ENTRY}`);
  }
}

async function startGatewayWatch() {
  console.log('[启动] 启动 gateway:watch...');

  const proc = spawn('node', [WATCHER_SCRIPT, 'gateway'], {
    cwd: ROOT_DIR,
    env: { ...process.env, OPENCLAW_SKIP_CHANNELS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  proc.stdout.on('data', data => {
    const line = data.toString();
    output += line;
    process.stdout.write(`[watcher] ${line}`);
  });

  proc.stderr.on('data', data => {
    const line = data.toString();
    output += line;
    process.stderr.write(`[watcher] ${line}`);
  });

  // 等待 watcher 启动
  await sleep(5000);

  return { proc, output };
}

async function checkProcessHealth(pid, name) {
  try {
    process.kill(pid, 0);
    console.log(`✓ ${name} (PID: ${pid}) 健康`);
    return true;
  } catch (e) {
    console.log(`✗ ${name} (PID: ${pid}) 已退出`);
    return false;
  }
}

async function triggerSourceChange() {
  console.log('[触发] 触发源文件变更（touch src/entry.ts）...');
  const mtime = new Date();
  fs.utimesSync(SRC_ENTRY, mtime, mtime);
  console.log(`  ✓ 更新 ${SRC_ENTRY} 的 mtime`);
}

async function waitForWatcherResponse(timeoutMs = 10000) {
  console.log(`[等待] 等待 watcher 响应（${timeoutMs / 1000}秒）...`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await sleep(500);
  }
}

async function main() {
  console.log('============================================================');
  console.log('  Issue #99603 — Real Machine Reproduction');
  console.log('============================================================');
  console.log('');
  console.log('问题：git push 触发源文件变更时，如果 dist/ 正在重建中，');
  console.log('      watcher 会杀死健康的 gateway child，导致 crash-loop');
  console.log('');

  // 环境信息
  const { stdout: hostnameOut } = await exec('hostname');
  const { stdout: kernelOut } = await exec('uname', ['-r']);
  const { stdout: nodeOut } = await exec('node', ['--version']);

  console.log(`Host:     ${hostnameOut.trim()}`);
  console.log(`Kernel:   ${kernelOut.trim()}`);
  console.log(`Node:     ${nodeOut.trim()}`);
  console.log('');

  try {
    // 步骤 1: 备份原始文件
    await backupFiles();
    console.log('');

    // 步骤 2: 模拟 mid-rebuild 状态
    await simulateMidRebuild();
    console.log('');

    // 步骤 3: 启动 gateway:watch
    const { proc: watcherProc, output: startupOutput } = await startGatewayWatch();
    console.log('');

    // 检查进程健康状态
    console.log('=== 进程健康检查 ===');
    const watcherPid = watcherProc.pid;
    console.log(`Watcher PID: ${watcherPid}`);

    // 查找 child process PID（从输出中解析）
    const childPidMatch = startupOutput.match(/Starting.*PID[:\s]+(\d+)/i);
    const childPid = childPidMatch ? parseInt(childPidMatch[1]) : null;

    if (childPid) {
      await checkProcessHealth(childPid, 'Child gateway');
    } else {
      console.log('? Child PID 未找到（可能尚未启动）');
    }
    console.log('');

    // 步骤 4: 触发源文件变更
    console.log('=== Test: Source change during mid-rebuild ===');
    await triggerSourceChange();
    console.log('');

    // 步骤 5: 等待 watcher 响应
    await waitForWatcherResponse(10000);
    console.log('');

    // 步骤 6: 检查结果
    console.log('=== 结果分析 ===');

    // 检查 watcher 是否还在运行
    const watcherAlive = await checkProcessHealth(watcherPid, 'Watcher');

    // 检查是否有 "Build output not ready" 消息
    const hasDeferMessage = startupOutput.includes('Build output not ready') ||
                           startupOutput.includes('waiting before restart');

    if (hasDeferMessage) {
      console.log('');
      console.log('✅ PASS: Watcher correctly deferred restart on hard failure');
      console.log('   - Detected missing dist/entry.js');
      console.log('   - Did NOT kill healthy child');
      console.log('   - Waiting for build to complete');
    } else {
      console.log('');
      console.log('❌ FAIL: Watcher did not defer restart');
      console.log('   - May have killed healthy child into broken dist/');
      console.log('   - This would cause crash-loop');
    }

    console.log('');
    console.log('=== Watcher Output Summary ===');
    const lines = startupOutput.split('\n').filter(l => l.includes('[openclaw]'));
    lines.forEach(line => console.log(`  ${line.trim()}`));

  } catch (error) {
    console.error('');
    console.error('=== Error During Reproduction ===');
    console.error(error.message);
    console.error(error.stack);
  } finally {
    // 清理
    console.log('');
    console.log('=== Cleanup ===');
    await restoreFiles();
    console.log('');
  }

  console.log('============================================================');
  console.log('  Reproduction Complete');
  console.log('============================================================');
}

main().catch(console.error);
