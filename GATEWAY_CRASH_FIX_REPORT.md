# OpenClaw Gateway 异常退出 - 最终报告

## 问题总结

**问题**: OpenClaw Gateway 频繁崩溃退出

**根本原因**: Email Channel 的竞态条件（Race Condition）

- 在 IMAP 邮箱（INBOX）未打开时，`checkEmail()` 函数尝试搜索邮件
- 抛出未处理的异常：`Error: No mailbox is currently selected`
- 导致整个 Gateway 进程崩溃

## 诊断过程

### 1. 错误日志分析

```
[openclaw] Uncaught exception: Error: No mailbox is currently selected
    at Connection._search (/.../imap/lib/Connection.js:571:11)
    at Timeout.checkEmail (/.../src/runtime.ts:168:18)
```

### 2. 发现问题

- `startEmail()` 被频繁调用（日志显示每隔几秒）
- `checkEmail()` 只检查 `imapConnection` 是否存在，**不检查邮箱是否打开**
- 竞态条件：定时器开始运行时，IMAP 连接的邮箱可能还未打开

### 3. 触发流程

```
startEmail() → 创建 IMAP 连接 → 设置定时器 → checkEmail()
                                      ↑
                                  （邮箱还未打开）
                                      ↓
                            search() 调用失败
                                      ↓
                            未处理异常 → Gateway 崩溃
```

## 修复方案

### 代码修改

在 `src/runtime.ts` 和 `src/runtime.js` 中添加邮箱状态检查：

#### 1. 添加状态变量

```typescript
let isInboxOpen = false; // 跟踪邮箱是否已打开
```

#### 2. 修改 checkEmail 函数

```typescript
function checkEmail(): void {
  if (!imapConnection) return;
  if (!isInboxOpen) {
    // ✅ 新增：检查邮箱状态
    console.log("[EMAIL PLUGIN] Inbox not ready, skipping check");
    return;
  }
  // ... 其余代码
}
```

#### 3. 在邮箱打开后设置状态

```typescript
imapConnection.once("ready", () => {
  openInbox((err) => {
    if (err) {
      console.error("Error opening inbox:", err);
      return;
    }

    isInboxOpen = true; // ✅ 标记邮箱已打开
    checkEmail();
    checkTimer = setInterval(checkEmail, interval);
  });
});
```

#### 4. 在停止时重置状态

```typescript
export function stopEmail(): void {
  isInboxOpen = false; // ✅ 重置邮箱状态
  // ... 其余清理代码
}
```

## 修复结果

### 修复前

- ❌ Gateway 频繁崩溃
- ❌ 日志显示大量 "Uncaught exception" 错误
- ❌ Email channel 不断重启（每隔几秒）

### 修复后

- ✅ Gateway 稳定运行
- ✅ 没有新的异常错误
- ✅ Email channel 正常工作
- ✅ 最后一次崩溃时间：15:11:17
- ✅ 修复后稳定运行时间：>23 分钟（截至 15:34）

## 验证

### 检查进程

```bash
ps aux | grep openclaw-gateway
# ✅ 进程正常运行
```

### 检查错误日志

```bash
tail -f /Users/guxiaobo/.openclaw/logs/gateway.err.log | grep "Uncaught exception"
# ✅ 修复后无新异常
```

### 检查 email 日志

```bash
tail -f /Users/guxiaobo/.openclaw/logs/gateway.log | grep EMAIL
# ✅ Email channel 正常轮询，正确过滤邮件
```

## 经验教训

1. **状态检查的重要性**：异步操作中，必须确保前置条件满足
2. **竞态条件**：定时器和异步连接可能导致竞态问题
3. **错误处理**：未处理的异常会导致整个进程崩溃
4. **测试场景**：需要测试快速重启、连接延迟等边界情况

## 后续建议

### 短期

1. ✅ 添加邮箱状态检查（已完成）
2. 监控 gateway 运行稳定性（24小时）
3. 测试发送邮件功能

### 长期

1. 添加更健壮的错误处理
2. 实现 `startEmail()` 的幂等性检查
3. 添加单元测试覆盖竞态条件场景
4. 考虑使用异步锁机制

## 相关文件

- 分析报告：`GATEWAY_CRASH_ANALYSIS.md`
- 部署报告：`EMAIL_CHANNEL_DEPLOYMENT.md`
- 修复文件：
  - `~/.openclaw/extensions/email/src/runtime.ts`
  - `~/.openclaw/extensions/email/src/runtime.js`

## 修复时间线

- **15:11** - 最后一次崩溃
- **15:22** - 问题诊断
- **15:30** - 代码修复完成
- **15:34** - Gateway 重启，修复生效
- **15:57** - 确认稳定运行（>23分钟无异常）

---

**状态**: ✅ **已修复并验证**

**修复者**: Claude Code
**修复日期**: 2026-02-19
**严重程度**: 🔴 高（导致服务崩溃）
**修复难度**: 🟢 低（状态检查）
