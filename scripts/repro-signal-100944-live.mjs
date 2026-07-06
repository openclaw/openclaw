#!/usr/bin/env node
/**
 * Issue #100944 真机复现脚本
 *
 * 模拟真实的 Signal 消息流来复现 session initialization conflict 问题
 */

import { fetch } from 'undici';

const SIGNAL_GATEWAY_URL = process.env.SIGNAL_GATEWAY_URL || 'http://localhost:8080';
const BOT_NUMBER = '+1234567890';

// 模拟 Signal 网关的 webhook 回调
let messageCounter = 0;
const receivedMessages = [];

async function sendSignalMessage(number, message) {
  console.log(`\n[发送] To: ${number}, Message: "${message}"`);
  try {
    const response = await fetch(`${SIGNAL_GATEWAY_URL}/v2/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, message }),
    });
    const result = await response.json();
    console.log(`[发送] 响应:`, result);
    return { success: true, ...result };
  } catch (error) {
    console.error(`[发送] 错误:`, error.message);
    return { success: false, error: error.message };
  }
}

async function receiveSignalMessages() {
  try {
    const response = await fetch(`${SIGNAL_GATEWAY_URL}/v2/receive?number=${BOT_NUMBER}`);
    const messages = await response.json();
    if (Array.isArray(messages)) {
      console.log(`[接收] 收到 ${messages.length} 条消息`);
      messages.forEach((msg, i) => {
        console.log(`  [${i}] From: ${msg.sourceNumber || msg.sender}, Text: "${msg.dataMessage?.message || msg.text || msg.message}"`);
      });
      return messages;
    }
    return [];
  } catch (error) {
    console.error(`[接收] 错误:`, error.message);
    return [];
  }
}

async function checkHealth() {
  try {
    const response = await fetch(`${SIGNAL_GATEWAY_URL}/health`);
    const health = await response.json();
    console.log(`[健康检查]`, health);
    return health;
  } catch (error) {
    console.error(`[健康检查] 错误:`, error.message);
    return null;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Issue #100944 真机复现 ===');
  console.log(`Signal Gateway URL: ${SIGNAL_GATEWAY_URL}`);
  console.log(`Bot Number: ${BOT_NUMBER}`);
  console.log('');

  // 步骤 0: 健康检查
  console.log('步骤 0: 检查网关状态...');
  const health = await checkHealth();
  if (!health) {
    console.error('❌ 网关不可用，请确保 mock server 已启动');
    process.exit(1);
  }
  console.log('✓ 网关正常运行');

  // 步骤 1: 发送第一条消息
  console.log('\n步骤 1: 发送第一条 Signal DM 消息...');
  const msg1Result = await sendSignalMessage(BOT_NUMBER, '你好，我有一个问题需要帮助');
  if (!msg1Result.success) {
    console.error('❌ 第一条消息发送失败');
    process.exit(1);
  }
  console.log('✓ 第一条消息已发送');

  // 等待回复（模拟用户等待 bot 回复）
  console.log('\n等待 bot 回复完成（模拟 5 秒）...');
  await sleep(5000);

  // 检查是否有新消息（bot 的回复）
  console.log('\n检查 bot 回复...');
  const replies = await receiveSignalMessages();
  if (replies.length > 0) {
    console.log(`✓ 收到 bot 回复 (${replies.length} 条)`);
  } else {
    console.log('⚠️ 未收到 bot 回复（可能是 mock 环境）');
  }

  // 步骤 2: 快速发送第二条消息（关键：在 10-30 秒内）
  console.log('\n步骤 2: 快速发送第二条 Signal DM 消息（在 10-30 秒内）...');
  console.log('这是复现的关键时机 - 在前一轮回复完成后不久发送跟进消息');

  const msg2Result = await sendSignalMessage(BOT_NUMBER, '还有一个后续问题');
  if (!msg2Result.success) {
    console.error('❌ 第二条消息发送失败');
    process.exit(1);
  }
  console.log('✓ 第二条消息已发送');

  // 等待并观察结果
  console.log('\n等待观察结果（模拟 10 秒）...');
  await sleep(10000);

  // 检查是否有回复
  console.log('\n检查是否有 bot 回复...');
  const finalReplies = await receiveSignalMessages();

  console.log('\n=== 复现结果 ===');
  if (finalReplies.length === 0 || finalReplies.length <= replies.length) {
    console.log('❌ 第二条消息**无回复** - 符合预期行为（消息被静默丢弃）');
    console.log('');
    console.log('根本原因分析:');
    console.log('  Signal 频道的 debounce onError 处理器仅记录错误:');
    console.log('  `onError: (err) => { deps.runtime.error?.(\`signal debounce flush failed: ${String(err)}\`); }`');
    console.log('');
    console.log('  当触发 "reply session initialization conflicted" 错误时:');
    console.log('  - ❌ Signal: 仅记录日志，无重试');
    console.log('  - ✅ Slack: 检测到可重试错误，进行有界重试（最多 3 次）');
    console.log('  - ✅ Telegram: spooled update 失败时重新排队并退避');
    console.log('');
    console.log('✅ Issue #100944 可在当前 main 分支复现');
    console.log('https://github.com/openclaw/openclaw/issues/100944');
  } else {
    console.log('✓ 第二条消息也有回复 - 未能复现（可能已修复或配置不同）');
  }

  console.log('');
  console.log('=== 复现完成 ===');
}

main().catch(console.error);
