---
summary: "OpenClaw Gateway CLI (`openclaw gateway …`) — 运行、查询和发现 Gateway"
read_when:
  - 从 CLI 运行 Gateway（开发或服务器）
  - 调试 Gateway 认证、绑定模式和连接性
  - 通过 Bonjour 发现 Gateway（本地 + 广域 DNS-SD）
title: "gateway"
x-i18n:
  source_path: cli/gateway.md
  source_hash: ada915c4e1369a75a9d7c4628dde9420ca4cbeb19e2c5b0eb00c06f5d99c2b18
  generated_at: "2026-04-10T00:00:00Z"
  workflow: manual
---

# Gateway CLI

Gateway 是 OpenClaw 的 WebSocket 服务器（渠道、节点、会话、hooks）。

本页面中的子命令位于 `openclaw gateway …` 下。

相关文档：

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## 运行 Gateway

运行本地 Gateway 进程：

```bash
openclaw gateway
```

前台别名：

```bash
openclaw gateway run
```

注意事项：

- 默认情况下，除非在 `~/.openclaw/openclaw.json` 中设置了 `gateway.mode=local`，否则 Gateway 拒绝启动。使用 `--allow-unconfigured` 进行临时/开发运行。
- `openclaw onboard --mode local` 和 `openclaw setup` 应该会写入 `gateway.mode=local`。如果文件存在但缺少 `gateway.mode`，请将其视为配置损坏并进行修复，而不是隐式地假设为本地模式。
- 如果文件存在但缺少 `gateway.mode`，Gateway 会将此视为可疑的配置损坏，并拒绝为你"猜测本地模式"。
- 在没有认证的情况下绑定到 loopback 之外是被阻止的（安全防护）。
- `SIGUSR1` 触发进程内重启（当授权允许时，`commands.restart` 默认启用；设置 `commands.restart: false` 可阻止手动重启，但 gateway 工具/配置应用/更新仍然允许）。
- `SIGINT`/`SIGTERM` 处理器会停止 gateway 进程，但不会恢复任何自定义终端状态。如果你用 TUI 或 raw-mode 输入包装 CLI，请在退出前恢复终端。

### 选项

- `--port <port>`：WebSocket 端口（默认来自配置/环境变量；通常为 `18789`）。
- `--bind <loopback|lan|tailnet|auto|custom>`：监听器绑定模式。
- `--auth <token|password>`：认证模式覆盖。
- `--token <token>`：token 覆盖（同时为进程设置 `OPENCLAW_GATEWAY_TOKEN`）。
- `--password <password>`：密码覆盖。警告：内联密码可能在本地进程列表中暴露。
- `--password-file <path>`：从文件读取 gateway 密码。
- `--tailscale <off|serve|funnel>`：通过 Tailscale 暴露 Gateway。
- `--tailscale-reset-on-exit`：关闭时重置 Tailscale serve/funnel 配置。
- `--allow-unconfigured`：允许 gateway 在没有配置中 `gateway.mode=local` 的情况下启动。这绕过了临时/开发引导的启动保护；它不会写入或修复配置文件。
- `--dev`：如果缺少则创建开发配置 + 工作区（跳过 BOOTSTRAP.md）。
- `--reset`：重置开发配置 + 凭证 + 会话 + 工作区（需要 `--dev`）。
- `--force`：在启动前终止所选端口上的任何现有监听器。
- `--verbose`：详细日志。
- `--cli-backend-logs`：仅在控制台中显示 CLI 后端日志（并启用 stdout/stderr）。
- `--ws-log <auto|full|compact>`：websocket 日志样式（默认 `auto`）。
- `--compact`：`--ws-log compact` 的别名。
- `--raw-stream`：将原始模型流事件记录到 jsonl。
- `--raw-stream-path <path>`：原始流 jsonl 路径。

## 查询运行中的 Gateway

所有查询命令都使用 WebSocket RPC。

输出模式：

- 默认：人类可读（TTY 中彩色显示）。
- `--json`：机器可读 JSON（无样式/进度条）。
- `--no-color`（或 `NO_COLOR=1`）：禁用 ANSI 同时保持人类可读布局。

通用选项（在支持的地方）：

- `--url <url>`：Gateway WebSocket URL。
- `--token <token>`：Gateway token。
- `--password <password>`：Gateway 密码。
- `--timeout <ms>`：超时/预算（因命令而异）。
- `--expect-final`：等待"最终"响应（agent 调用）。

注意：当你设置 `--url` 时，CLI 不会回退到配置或环境凭证。需要显式传递 `--token` 或 `--password`。缺少显式凭证会报错。

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway usage-cost`

从会话日志中获取使用成本摘要。

```bash
openclaw gateway usage-cost
openclaw gateway usage-cost --days 7
openclaw gateway usage-cost --json
```
