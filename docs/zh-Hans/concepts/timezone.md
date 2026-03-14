---
read_when:
  - 需要了解时间戳如何为模型进行规范化
  - 为系统提示词配置用户时区
summary: 智能体、信封和提示词的时区处理
title: 时区
x-i18n:
  generated_at: "2026-02-01T20:24:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 9ee809c96897db1126c7efcaa5bf48a63cdcb2092abd4b3205af224ebd882766
  source_path: concepts/timezone.md
  workflow: 14
---

# 时区

OpenClaw 对时间戳进行标准化，使模型看到**单一的参考时间**。

## 消息信封（默认为本地时间）

入站消息被包装在如下信封中：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

信封中的时间戳**默认为主机本地时间**，精确到分钟。

你可以通过以下配置进行覆盖：

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA 时区
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` 使用 UTC。
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退到主机时区）。
- 使用显式 IANA 时区（例如 `"Europe/Vienna"`）可设置固定偏移量。
- `envelopeTimestamp: "off"` 从信封头中移除绝对时间戳。
- `envelopeElapsed: "off"` 移除已用时间后缀（`+2m` 样式）。

### 示例

**本地时间（默认）：**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**固定时区：**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**已用时间：**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## 工具负载（原始提供商数据 + 规范化字段）

工具调用（`channels.discord.readMessages`、`channels.slack.readMessages` 等）返回**原始提供商时间戳**。我们还附加规范化字段以保持一致性：

- `timestampMs`（UTC 纪元毫秒数）
- `timestampUtc`（ISO 8601 UTC 字符串）

原始提供商字段保持不变。

## 系统提示词的用户时区

设置 `agents.defaults.userTimezone` 来告知模型用户的本地时区。如果未设置，OpenClaw 会在运行时**解析主机时区**（无需写入配置）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

系统提示词包含：

- `Current Date & Time` 部分，显示本地时间和时区
- `Time format: 12-hour` 或 `24-hour`

你可以通过 `agents.defaults.timeFormat`（`auto` | `12` | `24`）控制提示词格式。

详情参见[日期与时间](/date-time)的完整行为和示例。
