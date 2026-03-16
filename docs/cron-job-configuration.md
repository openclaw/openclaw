# OpenClaw Cron Job 配置完全指南

## 快速选择表

| 场景 | Session类型 | Payload类型 | 示例 |
|------|------------|-------------|------|
| 简单通知/提醒 | main | systemEvent | 心跳检测、定时提醒 |
| 复杂任务/需AI处理 | isolated | agentTurn | 数据分析、内容生成 |
| 需指定模型 | isolated | agentTurn + model | 特定模型任务 |

---

## 两种Session类型详解

### 1. Main Session

**特点**:
- 使用现有的agent session
- 轻量级，快速执行
- **限制**: 只能用 `systemEvent`

**适用场景**:
- 系统状态通知
- 简单的心跳检测
- 不需要AI处理的纯通知

**配置示例**:
```json
{
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",
    "text": "[自动任务] 备份完成"
  }
}
```

**常见错误**:
```
Error: main cron jobs require payload.kind="systemEvent"
```
**原因**: 在main session中使用了 `agentTurn`
**解决**: 改为 `systemEvent` 或切换到 `isolated` session

---

### 2. Isolated Session

**特点**:
- 创建独立的session
- 可以指定model
- 可以执行复杂任务
- 超时控制更灵活

**适用场景**:
- 需要AI分析的任务
- 需要指定特定模型
- 耗时较长的任务
- 需要隔离环境的任务

**配置示例**:
```json
{
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "分析今日数据并生成报告",
    "model": "kimi-coding/kimi-for-coding",
    "timeoutSeconds": 300
  }
}
```

---

## 完整配置模板

### Template 1: 简单系统通知 (Main + systemEvent)
```json
{
  "name": "heartbeat-check",
  "schedule": {
    "kind": "every",
    "everyMs": 3600000
  },
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",
    "text": "系统心跳正常"
  },
  "delivery": {
    "mode": "announce"
  }
}
```

### Template 2: AI数据分析 (Isolated + agentTurn)
```json
{
  "name": "daily-analysis",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "分析昨日数据，生成摘要报告",
    "model": "my_api/claude-opus-4-6",
    "timeoutSeconds": 600
  },
  "delivery": {
    "mode": "announce",
    "channel": "telegram"
  }
}
```

### Template 3: 指定Kimi模型的任务
```json
{
  "name": "kimi-task",
  "schedule": {
    "kind": "every",
    "everyMs": 7200000
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "执行需要Kimi处理的任务",
    "model": "kimi-coding/kimi-for-coding",
    "timeoutSeconds": 300
  }
}
```

---

## 常见错误与解决方案

### Error 1: JSON解析错误
```
Unexpected non-whitespace character after JSON at position X
```

**原因**: message中包含特殊字符或未转义的引号

**解决**:
- 避免在message中使用复杂的JSON或代码块
- 使用简单的纯文本指令
- 如需复杂内容，让agent读取文件而非直接放在message中

---

### Error 2: Main session限制
```
main cron jobs require payload.kind="systemEvent"
```

**原因**: 在main session中使用了agentTurn

**解决**:
```json
// 错误
{
  "sessionTarget": "main",
  "payload": {
    "kind": "agentTurn",  // ❌ main不能用这个
    "message": "..."
  }
}

// 正确 - 方案1: 改为systemEvent
{
  "sessionTarget": "main",
  "payload": {
    "kind": "systemEvent",  // ✅
    "text": "..."
  }
}

// 正确 - 方案2: 改为isolated
{
  "sessionTarget": "isolated",  // ✅
  "payload": {
    "kind": "agentTurn",
    "message": "..."
  }
}
```

---

### Error 3: 超时
```
cron: job execution timed out
```

**原因**: 任务执行时间超过timeoutSeconds

**解决**:
- 增加 `timeoutSeconds` (最大通常600秒)
- 优化任务，减少执行时间
- 将大任务拆分为多个小任务

---

## 最佳实践

### 1. 超时设置建议
| 任务类型 | 建议超时 |
|---------|---------|
| 简单通知 | 30s |
| 数据查询 | 120s |
| AI生成内容 | 300s |
| 复杂分析 | 600s |

### 2. 模型选择建议
| 场景 | 推荐模型 |
|------|---------|
| 代码相关 | kimi-coding/kimi-for-coding |
| 分析/总结 | my_api/claude-opus-4-6 |
| 中文内容 | kimi-coding/kimi-for-coding |
| 长文本处理 | my_api/claude-opus-4-6 |

### 3. 交付设置
```json
// 只通知自己
{
  "delivery": {
    "mode": "announce"
  }
}

// 发送到特定频道
{
  "delivery": {
    "mode": "announce",
    "channel": "telegram",
    "to": "-1001234567890"
  }
}

// 静默执行（不通知）
{
  "delivery": {
    "mode": "none"
  }
}
```

---

## 调试技巧

### 1. 手动触发测试
```bash
openclaw cron run <job-id>
```

### 2. 查看执行历史
```bash
openclaw cron runs <job-id>
```

### 3. 检查错误详情
```bash
openclaw cron list
# 查看 lastError 字段
```

---

## 贡献者

- huangpi1030-tech: 本文档编写

---

如有问题，欢迎在 OpenClaw Discussion 中讨论。
