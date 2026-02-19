# OpenClaw Gateway 异常退出分析报告

## 问题诊断

### 错误信息

```
Error: No mailbox is currently selected
at Connection._search (/Users/guxiaobo/.openclaw/extensions/email/node_modules/imap/lib/Connection.js:571:11)
at Timeout.checkEmail (/Users/guxiaobo/.openclaw/extensions/email/src/runtime.ts:168:18)
```

### 根本原因

#### 1. 竞态条件 (Race Condition)

从错误日志可以看到 `startEmail called!` 被频繁调用（每隔几秒就调用一次），这表明：

- Email channel 不断重启
- 旧的定时器还在运行
- 新的连接还没完全建立

#### 2. 邮箱状态检查缺失

在 `runtime.ts` 的 `checkEmail()` 函数中：

```typescript
function checkEmail(): void {
  if (!imapConnection) return; // ❌ 只检查连接对象，不检查邮箱是否打开

  imapConnection.search([["SINCE", dateStr]], (err, results) => {
    // 这里会抛出 "No mailbox is currently selected" 错误
  });
}
```

**问题**：

- 只检查 `imapConnection` 对象是否存在
- **没有检查邮箱（INBOX）是否已经打开**
- 在邮箱未打开时调用 `search()` 导致异常

#### 3. 启动流程问题

```typescript
imapConnection.once("ready", () => {
  openInbox((err) => {
    if (err) {
      console.error("Error opening inbox:", err);
      return; // ❌ 打开失败后，定时器不会被设置，但之前的定时器可能还在运行
    }

    checkEmail();
    checkTimer = setInterval(checkEmail, interval);
  });
});
```

**问题**：

- 如果 `openInbox` 失败，只是返回，没有清理资源
- 如果 `startEmail` 被多次调用，旧的 `checkTimer` 没有被清理
- 多个定时器可能同时运行，导致竞态条件

### 触发流程

```
1. openclaw gateway 启动
2. email channel 初始化，调用 startEmail()
3. IMAP 连接开始建立（异步）
4. 在 IMAP 连接 ready 之前，checkTimer 定时器被启动
5. checkEmail() 被调用，但邮箱还没打开
6. 抛出 "No mailbox is currently selected" 异常
7. openclaw 捕获未处理异常，进程退出
8. LaunchAgent 自动重启，循环往复
```

## 修复方案

### 方案 1: 添加邮箱状态检查（推荐）

修改 `checkEmail()` 函数，添加邮箱状态检查：

```typescript
let isInboxOpen = false; // 新增状态标志

function checkEmail(): void {
  if (!imapConnection) return;
  if (!isInboxOpen) {
    // ✅ 检查邮箱是否已打开
    console.log("[EMAIL PLUGIN] Inbox not ready, skipping check");
    return;
  }

  // ... 其余代码
}

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

### 方案 2: 清理旧定时器和连接

在 `startEmail()` 开始时清理旧资源：

```typescript
export function startEmail(config: EmailConfig, handler: ...): void {
  // ✅ 先停止旧的定时器和连接
  stopEmail();

  console.error("[EMAIL PLUGIN] startEmail called!");
  // ... 其余代码
}
```

### 方案 3: 使用异步锁

更健壮的方案是使用异步锁或 Promise 确保操作顺序：

```typescript
let emailCheckInProgress = false;

function checkEmail(): async function () {
  if (!imapConnection || emailCheckInProgress) return;

  emailCheckInProgress = true;
  try {
    // ... 执行邮件检查
  } finally {
    emailCheckInProgress = false;
  }
}
```

## 立即修复步骤

### 步骤 1: 修改 runtime.ts

在 `checkEmail()` 函数中添加邮箱状态检查：

```typescript
// 在文件顶部添加状态变量
let isInboxOpen = false;

// 修改 checkEmail 函数
function checkEmail(): void {
  if (!imapConnection) return;
  if (!isInboxOpen) {
    console.log("[EMAIL PLUGIN] Inbox not ready, skipping check");
    return;
  }

  // ... 其余代码保持不变
}

// 修改 openInbox 回调
imapConnection.once("ready", () => {
  openInbox((err) => {
    if (err) {
      console.error("Error opening inbox:", err);
      return;
    }

    isInboxOpen = true; // 设置状态
    checkEmail();
    checkTimer = setInterval(checkEmail, interval);
  });
});

// 在 stopEmail 中重置状态
export function stopEmail(): void {
  isInboxOpen = false; // 重置状态
  // ... 其余代码
}
```

### 步骤 2: 重新编译（如果需要）

```bash
cd ~/.openclaw/extensions/email
# 如果有 TypeScript 编译步骤
npx tsc
```

### 步骤 3: 重启 Gateway

```bash
openclaw gateway restart
```

### 步骤 4: 验证修复

```bash
# 监控日志
tail -f /Users/guxiaobo/.openclaw/logs/gateway.log | grep EMAIL

# 检查是否还有异常
tail -f /Users/guxiaobo/.openclaw/logs/gateway.err.log
```

## 临时解决方案

如果暂时不想修改代码，可以：

1. **增加检查间隔**：在配置中设置更长的 `checkInterval`（如 60 或 120 秒）
2. **减少重启次数**：检查为什么 email channel 频繁重启

## 监控建议

修复后，建议监控以下指标：

1. **进程运行时间**：`ps aux | grep openclaw`
2. **异常日志**：`grep "Uncaught exception" /Users/guxiaobo/.openclaw/logs/gateway.err.log`
3. **重启次数**：`grep "startEmail called" /Users/guxiaobo/.openclaw/logs/gateway.err.log | wc -l`

## 总结

**问题**：竞态条件导致在邮箱未打开时尝试搜索邮件，抛出未处理异常，导致 gateway 崩溃

**修复**：在 `checkEmail()` 中添加邮箱状态检查，确保只在邮箱打开后执行搜索

**优先级**：🔴 高 - 导致服务不稳定，频繁崩溃

**修复难度**：🟢 低 - 只需添加状态检查，改动小
