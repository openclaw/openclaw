---
summary: "日志表面、文件日志、WS 日志样式和控制台格式"
read_when:
  - 更改日志输出或格式
  - 调试 CLI 或网关输出
title: "网关日志记录"
---

# 日志记录

有关面向用户的概述（CLI + Control UI + 配置），请参阅 [/logging](/logging)。

OpenClaw 有两个日志“表面”：

- **控制台输出**（您在终端 / 调试 UI 中看到的内容）。
- **文件日志**（JSON 行）由网关日志记录器写入。

## 基于文件的日志记录器

- 默认滚动日志文件位于 `/tmp/openclaw/` 下（每天一个文件）：`openclaw-YYYY-MM-DD.log`
  - 日期使用网关主机的本地时区。
- 日志文件路径和级别可以通过 `~/.openclaw/openclaw.json` 配置：
  - `logging.file`
  - `logging.level`

文件格式是每行一个 JSON 对象。

Control UI 日志选项卡通过网关（`logs.tail`）尾随此文件。
CLI 也可以这样做：

```bash
openclaw logs --follow
```

**详细与日志级别**

- **文件日志**完全由 `logging.level` 控制。
- `--verbose` 仅影响**控制台详细程度**（和 WS 日志样式）；它**不会**
  提高文件日志级别。
- 要在文件日志中捕获仅详细的详细信息，请将 `logging.level` 设置为 `debug` 或
  `trace`。

## 控制台捕获

CLI 捕获 `console.log/info/warn/error/debug/trace` 并将它们写入文件日志，
同时仍然打印到 stdout/stderr。

您可以通过以下方式独立调整控制台详细程度：

- `logging.consoleLevel`（默认 `info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## 工具摘要编辑

详细的工具摘要（例如 `🛠️ Exec: ...`）可以在敏感令牌到达控制台流之前对其进行掩码。这**仅适用于工具**，不会改变文件日志。

- `logging.redactSensitive`：`off` | `tools`（默认：`tools`）
- `logging.redactPatterns`：正则表达式字符串数组（覆盖默认值）
  - 使用原始正则表达式字符串（自动 `gi`），或 `/pattern/flags` 如果需要自定义标志。
  - 匹配项通过保留前 6 + 后 4 个字符（长度 >= 18）进行掩码，否则为 `***`。
  - 默认值覆盖常见的密钥分配、CLI 标志、JSON 字段、承载标头、PEM 块和流行的令牌前缀。

## 网关 WebSocket 日志

网关以两种模式打印 WebSocket 协议日志：

- **正常模式（无 `--verbose`）**：仅打印“有趣”的 RPC 结果：
  - 错误（`ok=false`）
  - 慢速调用（默认阈值：`>= 50ms`）
  - 解析错误
- **详细模式（`--verbose`）**：打印所有 WS 请求/响应流量。

### WS 日志样式

`openclaw gateway` 支持每个网关的样式开关：

- `--ws-log auto`（默认）：正常模式经过优化；详细模式使用紧凑输出
- `--ws-log compact`：详细时使用紧凑输出（配对的请求/响应）
- `--ws-log full`：详细时使用完整的每帧输出
- `--compact`：`--ws-log compact` 的别名

示例：

```bash
# 优化（仅错误/慢速）
openclaw gateway

# 显示所有 WS 流量（配对）
openclaw gateway --verbose --ws-log compact

# 显示所有 WS 流量（完整元数据）
openclaw gateway --verbose --ws-log full
```

## 控制台格式化（子系统日志记录）

控制台格式化器**感知 TTY** 并打印一致的、带前缀的行。
子系统日志记录器保持输出分组和可扫描。

行为：

- **每行的子系统前缀**（例如 `[gateway]`、`[canvas]`、`[tailscale]`）
- **子系统颜色**（每个子系统稳定）加上级别颜色
- **当输出是 TTY 或环境看起来像富终端时的颜色**（`TERM`/`COLORTERM`/`TERM_PROGRAM`），尊重 `NO_COLOR`
- **缩短的子系统前缀**：删除前导 `gateway/` + `channels/`，保留最后 2 个段（例如 `whatsapp/outbound`）
- **按子系统的子日志记录器**（自动前缀 + 结构化字段 `{ subsystem }`）
- **`logRaw()`** 用于 QR/UX 输出（无前缀，无格式化）
- **控制台样式**（例如 `pretty | compact | json`）
- **控制台日志级别**与文件日志级别分开（当 `logging.level` 设置为 `debug`/`trace` 时，文件保留完整详细信息）
- **WhatsApp 消息正文**在 `debug` 级别记录（使用 `--verbose` 查看它们）

这在保持交互式输出可扫描的同时，保持现有的文件日志稳定。