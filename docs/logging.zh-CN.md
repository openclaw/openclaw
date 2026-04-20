---
summary: "日志概述：文件日志、控制台输出、CLI 跟踪和 Control UI"
read_when:
  - 您需要日志系统的初学者友好概述
  - 您想要配置日志级别或格式
  - 您正在排查问题并需要快速找到日志
title: "日志概述"
---

# 日志系统

OpenClaw 有两个主要的日志表面：

- **文件日志**（JSON 行）由 Gateway 写入。
- **控制台输出** 显示在终端和 Gateway 调试 UI 中。

Control UI 的 **Logs** 选项卡会跟踪网关文件日志。本页面解释了日志的位置、如何读取它们以及如何配置日志级别和格式。

## 日志的位置

默认情况下，Gateway 会在以下位置写入滚动日志文件：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期使用网关主机的本地时区。

您可以在 `~/.openclaw/openclaw.json` 中覆盖此设置：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何读取日志

### CLI：实时跟踪（推荐）

使用 CLI 通过 RPC 跟踪网关日志文件：

```bash
openclaw logs --follow
```

有用的当前选项：

- `--local-time`：在您的本地时区中渲染时间戳
- `--url <url>` / `--token <token>` / `--timeout <ms>`：标准 Gateway RPC 标志
- `--expect-final`：代理支持的 RPC 最终响应等待标志（通过共享客户端层在此处接受）

输出模式：

- **TTY 会话**：漂亮、彩色、结构化的日志行。
- **非 TTY 会话**：纯文本。
- `--json`：行分隔的 JSON（每行一个日志事件）。
- `--plain`：在 TTY 会话中强制使用纯文本。
- `--no-color`：禁用 ANSI 颜色。

当您传递显式的 `--url` 时，CLI 不会自动应用配置或环境凭据；如果目标 Gateway 需要身份验证，请自己包含 `--token`。

在 JSON 模式下，CLI 会发出带有 `type` 标签的对象：

- `meta`：流元数据（文件、游标、大小）
- `log`：解析的日志条目
- `notice`：截断/轮换提示
- `raw`：未解析的日志行

如果本地环回 Gateway 要求配对，`openclaw logs` 会自动回退到配置的本地日志文件。显式的 `--url` 目标不使用此回退。

如果 Gateway 不可达，CLI 会打印一个简短提示，建议运行：

```bash
openclaw doctor
```

### Control UI（Web）

Control UI 的 **Logs** 选项卡使用 `logs.tail` 跟踪同一个文件。
请参阅 [/web/control-ui](/web/control-ui) 了解如何打开它。

### 仅通道日志

要过滤通道活动（WhatsApp/Telegram 等），请使用：

```bash
openclaw channels logs --channel whatsapp
```

## 日志格式

### 文件日志（JSONL）

日志文件中的每一行都是一个 JSON 对象。CLI 和 Control UI 解析这些条目以呈现结构化输出（时间、级别、子系统、消息）。

### 控制台输出

控制台日志是**感知 TTY 的**，并为可读性进行了格式化：

- 子系统前缀（例如 `gateway/channels/whatsapp`）
- 级别着色（info/warn/error）
- 可选的紧凑或 JSON 模式

控制台格式由 `logging.consoleStyle` 控制。

### Gateway WebSocket 日志

`openclaw gateway` 还具有用于 RPC 流量的 WebSocket 协议日志：

- 正常模式：仅显示有趣的结果（错误、解析错误、慢调用）
- `--verbose`：所有请求/响应流量
- `--ws-log auto|compact|full`：选择详细的渲染风格
- `--compact`：`--ws-log compact` 的别名

示例：

```bash
openclaw gateway
openclaw gateway --verbose --ws-log compact
openclaw gateway --verbose --ws-log full
```

## 配置日志

所有日志配置都位于 `~/.openclaw/openclaw.json` 中的 `logging` 下。

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

您可以通过 **`OPENCLAW_LOG_LEVEL`** 环境变量覆盖两者（例如 `OPENCLAW_LOG_LEVEL=debug`）。环境变量优先于配置文件，因此您可以在不编辑 `openclaw.json` 的情况下提高单次运行的详细程度。您还可以传递全局 CLI 选项 **`--log-level <level>`**（例如，`openclaw --log-level debug gateway run`），这会覆盖该命令的环境变量。

`--verbose` 仅影响控制台输出和 WS 日志详细程度；它不会更改文件日志级别。

### 控制台风格

`logging.consoleStyle`：

- `pretty`：人性化、彩色、带时间戳。
- `compact`：更紧凑的输出（最适合长时间会话）。
- `json`：每行 JSON（用于日志处理器）。

### 脱敏

工具摘要可以在敏感令牌到达控制台之前对其进行脱敏：

- `logging.redactSensitive`：`off` | `tools`（默认：`tools`）
- `logging.redactPatterns`：覆盖默认集的正则表达式字符串列表

脱敏仅影响**控制台输出**，不会更改文件日志。

## 诊断 + OpenTelemetry

诊断是针对模型运行**和**消息流遥测（webhooks、队列、会话状态）的结构化、机器可读事件。它们**不会**替换日志；它们的存在是为了提供指标、跟踪和其他导出器。

诊断事件在进程内发出，但仅当诊断 + 导出器插件启用时，导出器才会附加。

### OpenTelemetry 与 OTLP

- **OpenTelemetry (OTel)**：用于跟踪、指标和日志的数据模型 + SDK。
- **OTLP**：用于将 OTel 数据导出到收集器/后端的有线协议。
- OpenClaw 今天通过**OTLP/HTTP（protobuf）** 导出。

### 导出的信号

- **指标**：计数器 + 直方图（令牌使用、消息流、队列）。
- **跟踪**：用于模型使用 + webhook/消息处理的跨度。
- **日志**：当 `diagnostics.otel.logs` 启用时通过 OTLP 导出。日志量可能很高；请记住 `logging.level` 和导出器过滤器。

### 诊断事件目录

模型使用：

- `model.usage`：令牌、成本、持续时间、上下文、提供商/模型/通道、会话 ID。

消息流：

- `webhook.received`：每个通道的 webhook 入口。
- `webhook.processed`：webhook 处理 + 持续时间。
- `webhook.error`：webhook 处理程序错误。
- `message.queued`：消息入队等待处理。
- `message.processed`：结果 + 持续时间 + 可选错误。

队列 + 会话：

- `queue.lane.enqueue`：命令队列通道入队 + 深度。
- `queue.lane.dequeue`：命令队列通道出队 + 等待时间。
- `session.state`：会话状态转换 + 原因。
- `session.stuck`：会话卡住警告 + 年龄。
- `run.attempt`：运行重试/尝试元数据。
- `diagnostic.heartbeat`：聚合计数器（webhooks/队列/会话）。

### 启用诊断（无导出器）

如果您希望插件或自定义接收器可以使用诊断事件，请使用此选项：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 诊断标志（定向日志）

使用标志打开额外的、定向的调试日志，而不提高 `logging.level`。标志不区分大小写，支持通配符（例如 `telegram.*` 或 `*`）。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

环境覆盖（一次性）：

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注意：

- 标志日志会写入标准日志文件（与 `logging.file` 相同）。
- 输出仍然根据 `logging.redactSensitive` 进行脱敏。
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

- 您也可以使用 `openclaw plugins enable diagnostics-otel` 启用插件。
- `protocol` 目前仅支持 `http/protobuf`。`grpc` 被忽略。
- 指标包括令牌使用、成本、上下文大小、运行持续时间和消息流计数器/直方图（webhooks、队列、会话状态、队列深度/等待）。
- 跟踪/指标可以通过 `traces` / `metrics` 切换（默认：开启）。跟踪包括模型使用跨度以及启用时的 webhook/消息处理跨度。
- 当您的收集器需要身份验证时，设置 `headers`。
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

### 导出的跨度（名称 + 关键属性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（输入/输出/缓存读取/缓存写入/总计）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、`openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、`openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、`openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、`openclaw.sessionKey`、`openclaw.sessionId`

### 采样 + 刷新

- 跟踪采样：`diagnostics.otel.sampleRate`（0.0–1.0，仅根跨度）。
- 指标导出间隔：`diagnostics.otel.flushIntervalMs`（最小 1000ms）。

### 协议说明

- OTLP/HTTP 端点可以通过 `diagnostics.otel.endpoint` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 设置。
- 如果端点已经包含 `/v1/traces` 或 `/v1/metrics`，则按原样使用。
- 如果端点已经包含 `/v1/logs`，则按原样用于日志。
- `diagnostics.otel.logs` 启用主记录器输出的 OTLP 日志导出。

### 日志导出行为

- OTLP 日志使用与写入 `logging.file` 相同的结构化记录。
- 尊重 `logging.level`（文件日志级别）。控制台脱敏**不适用于** OTLP 日志。
- 高容量安装应优先使用 OTLP 收集器采样/过滤。

## 故障排除提示

- **Gateway 不可达？** 首先运行 `openclaw doctor`。
- **日志为空？** 检查 Gateway 是否正在运行并写入 `logging.file` 中的文件路径。
- **需要更多详细信息？** 将 `logging.level` 设置为 `debug` 或 `trace` 并重试。

## 相关

- [Gateway 日志内部](/gateway/logging) — WS 日志风格、子系统前缀和控制台捕获
- [诊断](/gateway/configuration-reference#diagnostics) — OpenTelemetry 导出和缓存跟踪配置
