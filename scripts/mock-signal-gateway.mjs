#!/usr/bin/env node
/**
 * Mock Signal Gateway Server for Issue #100944 reproduction
 *
 * 模拟 bbernhard/signal-cli-rest-api 和 OpenClaw gateway 的行为
 * 复现 session initialization conflict 导致的消息丢失问题
 */

import http from 'http';
import { URL } from 'url';

const PORT = process.env.MOCK_PORT || 8080;

// 模拟状态
let state = {
  lastReplyTimestamp: null,
  isProcessingReply: false,
  messageQueue: [],
  conflictCount: 0,
  retryCount: 0,
  retrySuccessful: false,
};

console.log(`=== Mock Signal Gateway Server ===`);
console.log(`监听端口: ${PORT}`);
console.log(`用于复现 Issue #100944: Signal DM silently dropped on reply session initialization conflict`);
console.log('');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const timestamp = new Date().toISOString();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`[${timestamp}] ${req.method} ${url.pathname}${url.search}`);

  // Health check endpoint
  if (url.pathname === '/health' || url.pathname === '/v1/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      version: 'mock-0.1.0',
      purpose: 'Issue #100944 reproduction',
    }));
    return;
  }

  // Send message endpoint (simulates user sending to bot)
  if (url.pathname === '/v2/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { number, message } = data;

        console.log(`  [发送] To: ${number}, Message: "${message}"`);

        // 将消息加入队列等待处理
        state.messageQueue.push({
          type: 'outbound',
          number,
          message,
          timestamp: Date.now(),
        });

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, timestamp: Date.now() }));

        // 模拟网关将消息转发给 OpenClaw
        await simulateGatewayProcessing(number, message);

      } catch (error) {
        console.error(`  [发送] 解析错误:`, error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  // Receive messages endpoint (simulates receiving from users)
  if (url.pathname === '/v2/receive' || url.pathname === '/v1/receive') {
    const messages = [...state.messageQueue.filter(m => m.type === 'inbound')];
    state.messageQueue = state.messageQueue.filter(m => m.type !== 'inbound');

    res.writeHead(200);
    res.end(JSON.stringify(messages));

    if (messages.length > 0) {
      console.log(`  [接收] 返回 ${messages.length} 条消息`);
    }
    return;
  }

  // 404 for unknown routes
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

async function simulateGatewayProcessing(number, message) {
  // 模拟网关将消息传递给 OpenClaw
  console.log(`  [网关] 转发消息给 OpenClaw...`);

  // 检查是否触发 session initialization conflict
  const now = Date.now();
  const timeSinceLastReply = state.lastReplyTimestamp ? (now - state.lastReplyTimestamp) : Infinity;

  // 如果在上次回复后 30 秒内收到新消息，触发 conflict
  const CONFLICT_WINDOW_MS = 30000; // 30 seconds
  const shouldTriggerConflict = timeSinceLastReply < CONFLICT_WINDOW_MS && timeSinceLastReply > 0;

  if (shouldTriggerConflict) {
    console.log(`  [网关] ⚠️ 检测到快速跟进消息 (${Math.round(timeSinceLastReply / 1000)}s 后)`);
    console.log(`  [网关] 触发 "reply session initialization conflicted" 错误...`);

    // 模拟 Signal 的 debounce onError 行为
    const sessionKey = `agent:main:signal:direct:${number}`;
    const errorMessage = `reply session initialization conflicted for ${sessionKey}`;

    // 检查是否有重试逻辑（修复后的行为）
    const hasRetryLogic = process.env.HAS_RETRY_LOGIC === '1';

    if (hasRetryLogic) {
      console.log(`  [Signal] ⚠️ debounce flush failed: Error: ${errorMessage}`);
      console.log(`  [Signal] ✅ 检测到可重试错误，**安排重试**（最多 3 次）`);

      state.conflictCount++;
      state.retryCount++;

      // 模拟重试成功（第二次尝试）
      if (state.retryCount <= 3) {
        console.log(`  [Signal] 🔄 执行第 ${state.retryCount} 次重试...`);
        await sleep(1000); // 重试延迟

        // 重试成功 - 模拟 bot 回复
        const botReply = `我收到了你的消息："${message}"。（重试成功）`;
        console.log(`  [OpenClaw] ✓ 重试成功，生成回复: "${botReply}"`);

        state.messageQueue.push({
          type: 'inbound',
          sourceNumber: number,
          senderName: 'Bot',
          timestamp: Date.now(),
          dataMessage: {
            message: botReply,
            attachments: [],
          }
        });

        state.lastReplyTimestamp = Date.now();
        state.retrySuccessful = true;
        console.log(`  [网关] ✓ 已送达回复到 ${number}（重试成功）`);
        return; // 重试成功，提前返回
      } else {
        console.log(`  [Signal] ❌ 达到最大重试次数（3 次），放弃并重记录错误`);
        state.retryCount = 0; // 重置计数器
      }
    } else {
      // 原始行为 - 无重试
      console.log(`  [Signal] ❌ debounce flush failed: Error: ${errorMessage}`);
      console.log(`  [Signal] ❌ 仅记录日志，**静默丢弃消息**，无重试机制`);

      state.conflictCount++;

      // 模拟延迟后不回复（消息被丢弃）
      await sleep(2000);
      console.log(`  [网关] ✗ 无回复（消息被丢弃）`);
    }

  } else {
    // 正常处理 - 模拟 bot 回复
    console.log(`  [OpenClaw] 处理消息...`);

    // 模拟处理延迟
    await sleep(3000 + Math.random() * 2000);

    const botReply = `我收到了你的消息："${message}"。有什么我可以帮助你的吗？`;
    console.log(`  [OpenClaw] ✓ 生成回复: "${botReply}"`);

    // 将回复加入队列
    state.messageQueue.push({
      type: 'inbound',
      sourceNumber: number,
      senderName: 'Bot',
      timestamp: Date.now(),
      dataMessage: {
        message: botReply,
        attachments: [],
      }
    });

    state.lastReplyTimestamp = Date.now();
    console.log(`  [网关] ✓ 已送达回复到 ${number}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

server.listen(PORT, () => {
  console.log(`\nMock server 已启动`);
  console.log(`\n使用说明:`);
  console.log(`1. 发送第一条消息:`);
  console.log(`   curl -X POST http://localhost:${PORT}/v2/send -H "Content-Type: application/json" -d '{"number":"+1234567890","message":"你好"}'`);
  console.log(`\n2. 等待 5 秒让 bot 回复完成`);
  console.log(`\n3. 快速发送第二条消息（10-30秒内）:`);
  console.log(`   curl -X POST http://localhost:${PORT}/v2/send -H "Content-Type: application/json" -d '{"number":"+1234567890","message":"还有一个问题"}'`);
  console.log(`\n4. 观察结果 - 第二条消息应该被静默丢弃（无回复）`);
  console.log(`\n5. 查看日志中的 "reply session initialization conflicted" 错误`);
  console.log(`\n按 Ctrl+C 停止服务器\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n关闭服务器...');
  console.log(`总共触发了 ${state.conflictCount} 次 session initialization conflict`);
  if (process.env.HAS_RETRY_LOGIC === '1') {
    console.log(`重试成功次数：${state.retrySuccessful ? '1' : '0'}`);
    console.log(`总重试次数：${state.retryCount}`);
  }
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});
