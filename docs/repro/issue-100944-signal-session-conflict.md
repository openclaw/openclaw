# Issue #100944 复现报告

**Issue**: [Signal DM silently dropped on reply session initialization conflict](https://github.com/openclaw/openclaw/issues/100944)

**复现日期**: 2026-07-06

**复现环境**:
- Node.js: v22.19.0
- pnpm: 11.2.2
- Git branch: `main` (commit: a327cec143)
- OS: Linux

---

## 问题描述

当 Signal 频道收到一条 DM，在前一轮回复完成后不久（约 10-30 秒内）发送跟进消息时：

1. **触发错误**: `reply session initialization conflicted for <sessionKey>`
2. **Signal 的处理**: 仅在日志中记录 `signal debounce flush failed: ...`
3. **结果**: 消息被**静默丢弃**，无重试机制，无用户可见的失败反馈

---

## 复现方法

### 方法一：单元测试复现（推荐）

运行测试文件：
```bash
export PATH="/home/$USER/.config/nvm/versions/node/v22.19.0/bin:$PATH"
pnpm test extensions/signal/src/monitor/event-handler.session-conflict-repro.test.ts
```

**测试输出**:
```
=== 复现结果 ===
✓ onFlush 仅调用 1 次（无重试）
✓ 错误日志包含 'signal debounce flush failed'
✓ 错误日志包含 'reply session initialization conflicted'

结论：Issue #100944 可在当前 main 分支复现
Signal 缺少像 Slack/Telegram 那样的重试机制
```

### 方法二：源码分析验证

检查关键代码位置：

**Signal** (`extensions/signal/src/monitor/event-handler.ts:683-685`):
```typescript
onError: (err) => {
  deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
},
// ❌ 仅记录错误，NO RETRY LOGIC
```

**Slack** (`extensions/slack/src/monitor/message-handler.ts:66-85, 120-159`):
```typescript
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

function isRetryableSlackInboundError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error])
    .some(candidate => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)));
}

const retryEntries = (sourceError: unknown): boolean => {
  if (!isRetryableSlackInboundError(sourceError)) {
    return false;
  }
  // ✅ 有界重试机制（最多 3 次，间隔 1 秒）
  const retryTimer = setTimeout(() => {
    for (const entry of nextEntries) {
      void enqueueSlackMessage(entry.message, entry.opts)...
    }
  }, RETRYABLE_FLUSH_RETRY_DELAY_MS);
};
```

**Telegram** (`extensions/telegram/src/polling-session.ts:820`):
```typescript
// ✅ spooled update 失败时重新排队并退避
await releaseTelegramSpooledUpdateClaim(params.update, {
  lastError: formatErrorMessage(params.err),
});
```

### 方法三：真机复现（需要 Signal 网关）

```bash
# 步骤 1: 发送第一条 Signal DM 消息
curl -X POST "$SIGNAL_GATEWAY_URL/v2/send" \
  -H "Content-Type: application/json" \
  -d '{"number": "<bot-number>", "message": "test1"}'
# ✓ 预期：收到 bot 回复

# 步骤 2: 等待回复完成（约 5-10 秒）
sleep 5

# 步骤 3: 快速发送第二条 Signal DM 消息（10-30秒内）
curl -X POST "$SIGNAL_GATEWAY_URL/v2/send" \
  -H "Content-Type: application/json" \
  -d '{"number": "<bot-number>", "message": "test2"}'
# ✗ 预期：**无回复**（消息被静默丢弃）

# 步骤 4: 检查网关日志
# 查找以下错误模式：
# '[signal] debounce flush failed: Error: reply session initialization conflicted for agent:main:signal:direct:<number>'
```

---

## 影响评估

| 维度 | 详情 |
|------|------|
| **受影响用户** | 任何在回复后短时间内发送跟进消息的 Signal DM 用户 |
| **严重程度** | P1（高优先级）- 静默消息丢失 |
| **频率** | 观察到单次会话中多次发生 |
| **后果** | 跟进问题被静默丢弃，用户认为 bot 无响应 |

---

## 对比其他频道

| 频道 | 重试逻辑 | 文件位置 |
|------|----------|----------|
| **Slack** | ✅ 有界重试（最多 3 次，间隔 1 秒） | `extensions/slack/src/monitor/message-handler.ts:66-85, 120-159` |
| **Telegram** | ✅ 重新排队 + 退避策略 | `extensions/telegram/src/polling-session.ts:820` |
| **Signal** | ❌ **缺失重试逻辑** | `extensions/signal/src/monitor/event-handler.ts:683-685` |

---

## 修复建议

参考 Slack 的实现，为 Signal 添加窄范围的重试逻辑：

1. 在 `extensions/signal/src/monitor/event-handler.ts` 中添加：
   ```typescript
   const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;
   
   function isRetryableSignalInboundError(error: unknown): boolean {
     return collectErrorGraphCandidates(error, (current) => [current.cause, current.error])
       .some(candidate => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)));
   }
   ```

2. 修改 `onError` 处理器：
   ```typescript
   onError: async (err, entries) => {
     if (isRetryableSignalInboundError(err)) {
       // 实现类似 Slack 的重试逻辑
       const retryEntries = entries.filter(e => (e.retryAttempt ?? 0) < MAX_RETRY_ATTEMPTS);
       if (retryEntries.length > 0) {
         setTimeout(() => {
           for (const entry of retryEntries) {
             await inboundDebouncer.enqueue({ ...entry, retryAttempt: (entry.retryAttempt ?? 0) + 1 });
           }
         }, RETRY_DELAY_MS);
         return;
       }
     }
     deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
   },
   ```

3. 添加回归测试覆盖此场景。

---

## 相关 Issue/PR

- #98234 - 已关闭的相同 Signal 问题报告
- #98416 - v2026.6.11 包一致性追踪器
- #99647 - Slack 重试修复（已合并）
- #96550 - Telegram 重试/退避行为（已合并）
- #98835 - Reply-session 修订检查窄化修复（已合并）

---

## GitHub URL

https://github.com/openclaw/openclaw/issues/100944
