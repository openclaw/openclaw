---
read_when:
  - 你需要一个适合初学者的日志概述
  - 你想配置日志级别或格式
  - 你正在故障排除并需要快速找到日志
summary: 日志概述：文件日志、控制台输出、CLI 跟踪和控制 UI
title: 日志
x-i18n:
  generated_at: "2026-02-03T07:50:52Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 884fcf4a906adff34d546908e22abd283cb89fe0845076cf925c72384ec3556b
  source_path: logging.md
  workflow: 15
---

# 日志

OpenClaw 在两个地方记录日志：

- **文件日志**（JSON 行）由 Gateway 网关写入。
- **控制台输出**显示在终端和控制 UI 中。

本页说明日志存放位置、如何读取日志以及如何配置日志级别和格式。

## 日志存放位置

默认情况下，Gateway 网关在以下位置写入滚动日志文件：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期使用 Gateway 网关主机的本地时区。

你可以在 `~/.openclaw/openclaw.json` 中覆盖此设置：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何读取日志

### CLI：实时跟踪（推荐）

使用 CLI 通过 RPC 跟踪 Gateway 网关日志文件：

```bash
openclaw logs --follow
```

输出模式：

- **TTY 会话**：美观、彩色、结构化的日志行。
- **非 TTY 会话**：纯文本。
- `--json`：行分隔的 JSON（每行一个日志事件）。
- `--plain`：在 TTY 会话中强制纯文本。
- `--no-color`：禁用 ANSI 颜色。

在 JSON 模式下，CLI 输出带 `type` 标签的对象：

- `meta`：流元数据（文件、游标、大小）
- `log`：解析的日志条目
- `notice`：截断/轮转提示
- `raw`：未解析的日志行

如果 Gateway 网关无法访问，CLI 会打印一个简短提示运行：

```bash
openclaw doctor
```

### 控制 UI（Web）

控制 UI 的**日志**标签页使用 `logs.tail` 跟踪相同的文件。
参见 [/web/control-ui](/web/control-ui) 了解如何打开它。

### 仅渠道日志

要过滤渠道活动（WhatsApp/Telegram 等），使用：

```bash
openclaw channels logs --channel whatsapp
```

## 日志格式

### 文件日志（JSONL）

日志文件中的每一行都是一个 JSON 对象。CLI 和控制 UI 解析这些条目以渲染结构化输出（时间、级别、子系统、消息）。

### 控制台输出

控制台日志**感知 TTY**并格式化以提高可读性：

- 子系统前缀（例如 `gateway/channels/whatsapp`）
- 级别着色（info/warn/error）
- 可选的紧凑或 JSON 模式

控制台格式由 `logging.consoleStyle` 控制。

## 配置日志

所有日志配置都在 `~/.openclaw/openclaw.json` 的 `logging` 下。

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### 日志级别

- `logging.level`：**文件日志**（JSONL）级别。
- `logging.consoleLevel`：**控制台**详细程度级别。

`--verbose` 仅影响控制台输出；它不改变文件日志级别。

### 控制台样式

`logging.consoleStyle`：

- `pretty`：人类友好、彩色、带时间戳。
- `compact`：更紧凑的输出（最适合长会话）。
- `json`：每行 JSON（用于日志处理器）。

### 脱敏

工具摘要可以在敏感令牌输出到控制台之前对其进行脱敏：

- `logging.redactSensitive`：`off` | `tools`（默认：`tools`）
- `logging.redactPatterns`：用于覆盖默认集的正则表达式字符串列表

脱敏仅影响**控制台输出**，不会改变文件日志。

## 诊断 + OpenTelemetry

诊断是用于模型运行**和**消息流遥测（webhooks、队列、会话状态）的结构化、机器可读事件。它们**不**替代日志；它们存在是为了向指标、追踪和其他导出器提供数据。

诊断事件在进程内发出，但导出器仅在启用诊断 + 导出器插件时才附加。

### OpenTelemetry 与 OTLP

- **OpenTelemetry（OTel）**：追踪、指标和日志的数据模型 + SDK。
- **OTLP**：用于将 OTel 数据导出到收集器/后端的线路协议。
- OpenClaw 目前通过 **OTLP/HTTP（protobuf）** 导出。

### 导出的信号

- **指标**：计数器 + 直方图（令牌使用、消息流、队列）。
- **追踪**：模型使用 + webhook/消息处理的 span。
- **日志**：启用 `diagnostics.otel.logs` 时通过 OTLP 导出。日志量可能很大；请注意 `logging.level` 和导出器过滤器。

### 诊断事件目录

模型使用：

- `model.usage`：令牌、成本、持续时间、上下文、提供商/模型/渠道、会话 ID。

消息流：

- `webhook.received`：每渠道的 webhook 入口。
- `webhook.processed`：webhook 已处理 + 持续时间。
- `webhook.error`：webhook 处理程序错误。
- `message.queued`：消息入队等待处理。
- `message.processed`：结果 + 持续时间 + 可选错误。

队列 + 会话：

- `queue.lane.enqueue`：命令队列通道入队 + 深度。
- `queue.lane.dequeue`：命令队列通道出队 + 等待时间。
- `session.state`：会话状态转换 + 原因。
- `session.stuck`：会话卡住警告 + 持续时间。
- `run.attempt`：运行重试/尝试元数据。
- `diagnostic.heartbeat`：聚合计数器（webhooks/队列/会话）。

### 启用诊断（无导出器）

如果你希望诊断事件可用于插件或自定义接收器，使用此配置：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 诊断标志（定向日志）

使用标志在不提高 `logging.level` 的情况下开启额外的定向调试日志。
标志不区分大小写，支持通配符（例如 `telegram.*` 或 `*`）。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

环境变量覆盖（一次性）：

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注意：

- 标志日志进入标准日志文件（与 `logging.file` 相同）。
- 输出仍根据 `logging.redactSensitive` 进行脱敏。
- 完整指南：[/diagnostics/flags](/diagnostics/flags)。

### 导出到 OpenTelemetry

诊断可以通过 `diagnostics-otel` 插件（OTLP/HTTP）导出。这适用于任何接受 OTLP/HTTP 的 OpenTelemetry 收集器/后端。

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

注意：

- 你也可以使用 `openclaw plugins enable diagnostics-otel` 启用插件。
- `protocol` 目前仅支持 `http/protobuf`。`grpc` 被忽略。
- 指标包括令牌使用、成本、上下文大小、运行持续时间和消息流计数器/直方图（webhooks、队列、会话状态、队列深度/等待）。
- 追踪/指标可以通过 `traces` / `metrics` 切换（默认：开启）。启用时，追踪包括模型使用 span 加上 webhook/消息处理 span。
- 当你的收集器需要认证时设置 `headers`。
- 支持的环境变量：`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### 导出的指标（名称 + 类型）

模型使用：

- `openclaw.tokens`（计数器，属性：`openclaw.token`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（计数器，属性：`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.run.duration_ms`（直方图，属性：`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（直方图，属性：`openclaw.context`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）

消息流：

- `openclaw.webhook.received`（计数器，属性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.error`（计数器，属性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.duration_ms`（直方图，属性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.message.queued`（计数器，属性：`openclaw.channel`、`openclaw.source`）
- `openclaw.message.processed`（计数器，属性：`openclaw.channel`、`openclaw.outcome`）
- `openclaw.message.duration_ms`（直方图，属性：`openclaw.channel`、`openclaw.outcome`）

队列 + 会话：

- `openclaw.queue.lane.enqueue`（计数器，属性：`openclaw.lane`）
- `openclaw.queue.lane.dequeue`（计数器，属性：`openclaw.lane`）
- `openclaw.queue.depth`（直方图，属性：`openclaw.lane` 或 `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（直方图，属性：`openclaw.lane`）
- `openclaw.session.state`（计数器，属性：`openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（计数器，属性：`openclaw.state`）
- `openclaw.session.stuck_age_ms`（直方图，属性：`openclaw.state`）
- `openclaw.run.attempt`（计数器，属性：`openclaw.attempt`）

### 导出的 span（名称 + 关键属性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（input/output/cache_read/cache_write/total）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、`openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、`openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、`openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、`openclaw.sessionKey`、`openclaw.sessionId`

### 采样 + 刷新

- 追踪采样：`diagnostics.otel.sampleRate`（0.0–1.0，仅根 span）。
- 指标导出间隔：`diagnostics.otel.flushIntervalMs`（最小 1000ms）。

### 协议说明

- OTLP/HTTP 端点可以通过 `diagnostics.otel.endpoint` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 设置。
- 如果端点已包含 `/v1/traces` 或 `/v1/metrics`，则按原样使用。
- 如果端点已包含 `/v1/logs`，则按原样用于日志。
- `diagnostics.otel.logs` 为主日志器输出启用 OTLP 日志导出。

### 日志导出行为

- OTLP 日志使用与写入 `logging.file` 相同的结构化记录。
- 遵守 `logging.level`（文件日志级别）。控制台脱敏**不**适用于 OTLP 日志。
- 高流量安装应优先使用 OTLP 收集器采样/过滤。

## 故障排除提示

- **Gateway 网关无法访问？** 先运行 `openclaw doctor`。
- **日志为空？** 检查 Gateway 网关是否正在运行并写入 `logging.file` 中的文件路径。
- **需要更多细节？** 将 `logging.level` 设置为 `debug` 或 `trace` 并重试。
