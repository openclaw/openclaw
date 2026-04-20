---
summary: "跨信封、提示、工具和连接器的日期和时间处理"
read_when:
  - 你正在更改如何向模型或用户显示时间戳
  - 你正在调试消息或系统提示输出中的时间格式化
title: "日期和时间"
---

# 日期和时间

OpenClaw 默认使用**主机本地时间作为传输时间戳**，并且**仅在系统提示中使用用户时区**。
提供商时间戳被保留，因此工具保持其原生语义（当前时间可通过 `session_status` 获得）。

## 消息信封（默认本地）

入站消息用时间戳（分钟精度）包装：

```
[Provider ... 2026-01-05 16:26 PST] 消息文本
```

此信封时间戳默认是**主机本地的**，与提供商时区无关。

你可以覆盖此行为：

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
- `envelopeTimezone: "local"` 使用主机时区。
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退到主机时区）。
- 使用显式 IANA 时区（例如，`"America/Chicago"`）作为固定时区。
- `envelopeTimestamp: "off"` 从信封头部移除绝对时间戳。
- `envelopeElapsed: "off"` 移除经过时间后缀（`+2m` 样式）。

### 示例

**本地（默认）：**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**用户时区：**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**启用经过时间：**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## 系统提示：当前日期和时间

如果用户时区已知，系统提示会包含一个专用的**当前日期和时间**部分，仅包含**时区**（无时钟/时间格式），以保持提示缓存稳定：

```
Time zone: America/Chicago
```

当代理需要当前时间时，使用 `session_status` 工具；状态卡包含时间戳行。

## 系统事件行（默认本地）

插入到代理上下文的排队系统事件使用与消息信封相同的时区选择（默认：主机本地）加上时间戳前缀。

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 配置用户时区和格式

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` 设置**用户本地时区**用于提示上下文。
- `timeFormat` 控制提示中的**12小时/24小时显示**。`auto` 遵循操作系统偏好。

## 时间格式检测（自动）

当 `timeFormat: "auto"` 时，OpenClaw 检查操作系统偏好（macOS/Windows）并回退到区域设置格式化。检测到的值**按进程缓存**，以避免重复的系统调用。

## 工具负载和连接器（原始提供商时间 + 标准化字段）

通道工具返回**提供商原生时间戳**并添加标准化字段以保持一致性：

- `timestampMs`：纪元毫秒（UTC）
- `timestampUtc`：ISO 8601 UTC 字符串

原始提供商字段被保留，因此不会丢失任何内容。

- Slack：来自 API 的类纪元字符串
- Discord：UTC ISO 时间戳
- Telegram/WhatsApp：提供商特定的数字/ISO 时间戳

如果你需要本地时间，请使用已知的时区在下游转换它。

## 相关文档

- [系统提示](/concepts/system-prompt)
- [时区](/concepts/timezone)
- [消息](/concepts/messages)