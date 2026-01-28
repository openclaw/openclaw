---
read_when:
  - 更改日志输出或格式
  - 调试 CLI 或 Gateway网关输出
summary: 日志界面、文件日志、WebSocket 日志样式和控制台格式化
title: 日志
x-i18n:
  generated_at: "2026-02-01T20:35:06Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: efb8eda5e77e3809369a8ff569fac110323a86b3945797093f20e9bc98f39b2e
  source_path: gateway/logging.md
  workflow: 14
---

# 日志

有关面向用户的概述（CLI + 控制界面 + 配置），请参阅 [/logging](/logging)。

OpenClaw 有两个日志"界面"：

- **控制台输出**（你在终端 / 调试界面中看到的内容）。
- **文件日志**（JSON 行），由 Gateway网关日志记录器写入。

## 基于文件的日志记录器

- 默认滚动日志文件位于 `/tmp/openclaw/` 下（每天一个文件）：`openclaw-YYYY-MM-DD.log`
  - 日期使用 Gateway网关主机的本地时区。
- 日志文件路径和级别可通过 `~/.openclaw/openclaw.json` 配置：
  - `logging.file`
  - `logging.level`

文件格式为每行一个 JSON 对象。

控制界面的日志标签页通过 Gateway网关（`logs.tail`）实时追踪此文件。
CLI 也可以执行相同操作：

```bash
openclaw logs --follow
```

**详细模式与日志级别**

- **文件日志** 仅由 `logging.level` 控制。
- `--verbose` 仅影响**控制台详细程度**（以及 WebSocket 日志样式）；它**不会**提升文件日志级别。
- 要在文件日志中捕获仅在详细模式下显示的细节，请将 `logging.level` 设置为 `debug` 或 `trace`。

## 控制台捕获

CLI 捕获 `console.log/info/warn/error/debug/trace` 并将其写入文件日志，同时仍然输出到 stdout/stderr。

你可以独立调整控制台详细程度：

- `logging.consoleLevel`（默认 `info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## 工具摘要脱敏

详细的工具摘要（例如 `🛠️ Exec: ...`）可以在敏感令牌进入控制台流之前对其进行掩码处理。这**仅适用于工具**，不会更改文件日志。

- `logging.redactSensitive`：`off` | `tools`（默认：`tools`）
- `logging.redactPatterns`：正则表达式字符串数组（覆盖默认值）
  - 使用原始正则字符串（自动 `gi`），如果需要自定义标志则使用 `/pattern/flags`。
  - 匹配项通过保留前 6 个和后 4 个字符进行掩码（长度 >= 18），否则显示 `***`。
  - 默认覆盖常见的键赋值、CLI 标志、JSON 字段、bearer 头、PEM 块和常见的令牌前缀。

## Gateway网关 WebSocket 日志

Gateway网关以两种模式打印 WebSocket 协议日志：

- **普通模式（无 `--verbose`）**：仅打印"有意义的" RPC 结果：
  - 错误（`ok=false`）
  - 慢调用（默认阈值：`>= 50ms`）
  - 解析错误
- **详细模式（`--verbose`）**：打印所有 WebSocket 请求/响应流量。

### WebSocket 日志样式

`openclaw gateway` 支持按 Gateway网关设置的样式开关：

- `--ws-log auto`（默认）：普通模式经过优化；详细模式使用紧凑输出
- `--ws-log compact`：详细模式下使用紧凑输出（配对的请求/响应）
- `--ws-log full`：详细模式下使用完整的逐帧输出
- `--compact`：`--ws-log compact` 的别名

示例：

```bash
# 优化模式（仅错误/慢调用）
openclaw gateway

# 显示所有 WS 流量（配对）
openclaw gateway --verbose --ws-log compact

# 显示所有 WS 流量（完整元数据）
openclaw gateway --verbose --ws-log full
```

## 控制台格式化（子系统日志）

控制台格式化器具有 **TTY 感知能力**，打印一致的、带前缀的行。
子系统日志记录器保持输出分组且易于扫描。

行为：

- 每行带有**子系统前缀**（例如 `[gateway]`、`[canvas]`、`[tailscale]`）
- **子系统颜色**（每个子系统稳定分配）加级别着色
- **当输出为 TTY 或环境看起来像富终端时启用颜色**（`TERM`/`COLORTERM`/`TERM_PROGRAM`），遵循 `NO_COLOR`
- **缩短的子系统前缀**：去掉前导的 `gateway/` + `channels/`，保留最后 2 个片段（例如 `whatsapp/outbound`）
- **按子系统的子日志记录器**（自动前缀 + 结构化字段 `{ subsystem }`）
- **`logRaw()`** 用于 QR/UX 输出（无前缀、无格式化）
- **控制台样式**（例如 `pretty | compact | json`）
- **控制台日志级别** 与文件日志级别分离（当 `logging.level` 设置为 `debug`/`trace` 时，文件保留完整细节）
- **WhatsApp 消息正文** 以 `debug` 级别记录（使用 `--verbose` 查看）

这在保持现有文件日志稳定的同时，使交互式输出更易于扫描。
