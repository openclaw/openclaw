---
read_when:
  - 更改日志输出或格式
  - 调试 CLI 或 Gateway 网关输出
summary: 日志输出界面、文件日志、WS 日志样式和控制台格式化
title: 日志
x-i18n:
  generated_at: "2026-02-03T07:48:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: efb8eda5e77e3809369a8ff569fac110323a86b3945797093f20e9bc98f39b2e
  source_path: gateway/logging.md
  workflow: 15
---

# 日志

面向用户的概览（CLI + Control UI + 配置），请参阅 [/logging](/logging)。

OpenClaw 有两个日志"界面"：

- **控制台输出**（你在终端 / Debug UI 中看到的内容）。
- **文件日志**（JSON 行）由 Gateway 网关日志记录器写入。

## 基于文件的日志记录器

- 默认滚动日志文件位于 `/tmp/openclaw/` 下（每天一个文件）：`openclaw-YYYY-MM-DD.log`
  - 日期使用 Gateway 网关主机的本地时区。
- 日志文件路径和级别可以通过 `~/.openclaw/openclaw.json` 配置：
  - `logging.file`
  - `logging.level`

文件格式是每行一个 JSON 对象。

Control UI 的 Logs 标签页通过 Gateway 网关（`logs.tail`）尾随此文件。CLI 也可以这样做：

```bash
openclaw logs --follow
```

**Verbose 与日志级别**

- **文件日志**完全由 `logging.level` 控制。
- `--verbose` 仅影响**控制台详细程度**（和 WS 日志样式）；它**不会**提高文件日志级别。
- 要在文件日志中捕获仅 verbose 的详细信息，请将 `logging.level` 设置为 `debug` 或 `trace`。

## 控制台捕获

CLI 捕获 `console.log/info/warn/error/debug/trace` 并将它们写入文件日志，同时仍打印到 stdout/stderr。

你可以独立调整控制台详细程度：

- `logging.consoleLevel`（默认 `info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## 工具摘要脱敏

详细工具摘要（例如 `🛠️ Exec: ...`）可以在进入控制台流之前屏蔽敏感令牌。这**仅限工具**，不会更改文件日志。

- `logging.redactSensitive`：`off` | `tools`（默认：`tools`）
- `logging.redactPatterns`：正则表达式字符串数组（覆盖默认值）
  - 使用原始正则字符串（自动 `gi`），或如果你需要自定义标志则使用 `/pattern/flags`。
  - 匹配项通过保留前 6 个 + 后 4 个字符（长度 >= 18）来屏蔽，否则为 `***`。
  - 默认值涵盖常见的键赋值、CLI 标志、JSON 字段、bearer 头、PEM 块和流行的令牌前缀。

## Gateway 网关 WebSocket 日志

Gateway 网关以两种模式打印 WebSocket 协议日志：

- **普通模式（无 `--verbose`）**：仅打印"有趣的"RPC 结果：
  - 错误（`ok=false`）
  - 慢调用（默认阈值：`>= 50ms`）
  - 解析错误
- **详细模式（`--verbose`）**：打印所有 WS 请求/响应流量。

### WS 日志样式

`openclaw gateway` 支持每个 Gateway 网关的样式切换：

- `--ws-log auto`（默认）：普通模式已优化；详细模式使用紧凑输出
- `--ws-log compact`：详细时使用紧凑输出（配对的请求/响应）
- `--ws-log full`：详细时使用完整的每帧输出
- `--compact`：`--ws-log compact` 的别名

示例：

```bash
# 优化的（仅错误/慢调用）
openclaw gateway

# 显示所有 WS 流量（配对）
openclaw gateway --verbose --ws-log compact

# 显示所有 WS 流量（完整元数据）
openclaw gateway --verbose --ws-log full
```

## 控制台格式化（子系统日志）

控制台格式化器是 **TTY 感知的**，打印一致的带前缀行。子系统日志记录器保持输出分组且易于扫描。

行为：

- 每行都有**子系统前缀**（例如 `[gateway]`、`[canvas]`、`[tailscale]`）
- **子系统颜色**（每个子系统稳定）加上级别着色
- **当输出是 TTY 或环境看起来像富终端时着色**（`TERM`/`COLORTERM`/`TERM_PROGRAM`），遵守 `NO_COLOR`
- **缩短的子系统前缀**：删除前导 `gateway/` + `channels/`，保留最后 2 个段（例如 `whatsapp/outbound`）
- **按子系统的子日志记录器**（自动前缀 + 结构化字段 `{ subsystem }`）
- **`logRaw()`** 用于 QR/UX 输出（无前缀，无格式化）
- **控制台样式**（例如 `pretty | compact | json`）
- **控制台日志级别**与文件日志级别分开（当 `logging.level` 设置为 `debug`/`trace` 时，文件保留完整详情）
- **WhatsApp 消息正文**以 `debug` 级别记录（使用 `--verbose` 查看它们）

这保持现有文件日志稳定，同时使交互式输出易于扫描。
