# Cron 核心模块详解

> Cron 提供定时任务功能，支持一次性提醒、周期性任务、自动降级确保送达。

## 目录

1. [Cron 概述](#cron-概述)
2. [任务类型](#任务类型)
3. [配置方法](#配置方法)
4. [执行流程](#执行流程)
5. [高级用法](#高级用法)

---

## Cron 概述

### 什么是 Cron？

**Cron = 定时任务系统**

它可以：
- ⏰ **一次性提醒**：N 分钟后提醒
- 📅 **周期性任务**：每天/每周/每月执行
- 🔔 **自动降级**：确保消息送达

---

## 任务类型

### 1. 一次性任务 (At)

```json5
{
  "name": "喝水提醒",
  "schedule": {
    "kind": "at",
    "atMs": 1774191405305 + 300000  // 5 分钟后
  },
  "payload": {
    "kind": "agentTurn",
    "message": "该喝水了！💧"
  }
}
```

### 2. 周期性任务 (Cron)

```json5
{
  "name": "每日天气",
  "schedule": {
    "kind": "cron",
    "expr": "0 8 * * *",      // 每天早上 8 点
    "tz": "Asia/Shanghai"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "早上好！今天天气不错☀️"
  }
}
```

### Cron 表达式

```
┌────── 分钟 (0-59)
│ ┌──── 小时 (0-23)
│ │ ┌── 日期 (1-31)
│ │ │ ┌─ 月份 (1-12)
│ │ │ │ ┓ 星期 (0-7, 0 和 7 都是周日)
│ │ │ │ ┃
* * * * *
```

**示例**：
- `0 8 * * *` - 每天早上 8 点
- `0 0 * * 1` - 每周一 0 点
- `*/30 * * * *` - 每 30 分钟
- `0 9-17 * * 1-5` - 工作日 9-17 点每小时

---

## 配置方法

### 通过 API 添加

```json5
// POST /cron

{
  "action": "add",
  "job": {
    "name": "提醒名",
    "schedule": {
      "kind": "at",
      "atMs": 1774191405305 + 300000
    },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "deleteAfterRun": true,
    "payload": {
      "kind": "agentTurn",
      "message": "你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：{提醒内容}",
      "deliver": true,
      "channel": "qqbot",
      "to": "用户 ID"
    }
  }
}
```

### 关键字段说明

| 字段 | 说明 | 必填 |
|------|------|------|
| `name` | 任务名称 | 是 |
| `schedule.kind` | `at` 或 `cron` | 是 |
| `schedule.atMs` | 执行时间戳（at 类型） | 条件 |
| `schedule.expr` | Cron 表达式（cron 类型） | 条件 |
| `payload.kind` | 必须是 `agentTurn` | 是 |
| `payload.deliver` | 是否发送消息 | 是 |
| `payload.channel` | 发送渠道 | 是 |
| `payload.to` | 发送目标 | 是 |

---

## 执行流程

```
1. Cron 服务检查到期任务
       │
       ▼
2. 唤醒 Agent（如需要）
       │
       ▼
3. 执行 payload
   ├─ agentTurn: 调用 Agent 生成消息
   └─ systemEvent: 触发系统事件
       │
       ▼
4. 发送消息（如 deliver=true）
       │
       ▼
5. 记录执行结果
   ├─ 成功：标记完成
   └─ 失败：重试或降级
       │
       ▼
6. 清理（如 deleteAfterRun=true）
```

---

## 高级用法

### 1. 心跳任务

```json5
{
  "name": "心跳检查",
  "schedule": {
    "kind": "cron",
    "expr": "*/30 * * * *"  // 每 30 分钟
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK.",
    "deliver": false  // 不发送，仅检查
  }
}
```

### 2. 工作日提醒

```json5
{
  "name": "上班打卡",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * 1-5",  // 工作日 9 点
    "tz": "Asia/Shanghai"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "上班啦！记得打卡哦⏰",
    "deliver": true,
    "channel": "qqbot",
    "to": "用户 ID"
  }
}
```

### 3. 生日提醒

```json5
{
  "name": "生日祝福",
  "schedule": {
    "kind": "cron",
    "expr": "0 0 15 3 *",  // 每年 3 月 15 日
    "tz": "Asia/Shanghai"
  },
  "payload": {
    "kind": "agentTurn",
    "message": "生日快乐！🎂🎉",
    "deliver": true,
    "channel": "qqbot",
    "to": "用户 ID"
  }
}
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
