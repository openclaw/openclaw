---
name: yuanbao-log-analysis
description: |
  查询 openclaw 系统日志中的异常记录。当用户在 yuanbao channel 对话中提到"日志分析"、"问题分析"或"异常日志"时自动激活。
---

# 日志分析 Skill

当用户提到"日志分析"、"问题分析"或"异常日志"时，查询 openclaw 系统最近 10 分钟的 warn、error、fatal 级别日志并输出摘要。

## 触发条件

用户消息包含以下任一关键词即激活：

- 日志分析
- 问题分析
- 异常日志

## 执行步骤

1. 调用 `logs.tail` 获取系统日志（limit 设为 2000 以覆盖近 10 分钟的日志量）。

2. 逐行解析日志，每行是一个 JSON 对象，结构示例：

```json
{
  "0": "message text",
  "_meta": {
    "logLevelName": "WARN",
    "date": "2026-03-16T12:00:00.000Z",
    "name": "{\"subsystem\":\"gateway\",\"module\":\"ws\"}"
  }
}
```

3. 过滤条件：
   - `_meta.logLevelName` 为 `WARN`、`ERROR` 或 `FATAL`（不区分大小写）。
   - `_meta.date` 在当前时间往前 10 分钟以内。

4. 对每条命中的日志，提取一行摘要，格式为：

```
[时间][级别][子系统] 消息内容
```

其中时间取 `_meta.date`，只保留 `HH:mm:ss`；级别取 `_meta.logLevelName`；子系统取 `_meta.name` 中解析出的 `subsystem` 字段；消息内容取 JSON 中数字键（`"0"`, `"1"`, ...）拼接的文本。

5. 如果没有命中任何日志，输出：过去 10 分钟内无问题级别日志。

## 输出要求

- 不要输出思考过程。
- 只列出日志摘要，不分析代码层面的问题。
- 输出格式为纯文本，不使用任何 Markdown 语法。
- 每条日志摘要占一行，行首不加任何符号。
- 按时间正序排列。

## 输出示例

```
12:03:15 WARN gateway WebSocket 连接超时 peer=10.0.0.5
12:05:22 ERROR queue 消息投递失败 msgId=abc123 reason=timeout
12:07:41 WARN session 会话状态异常 sessionId=s_001 state=stuck
```
