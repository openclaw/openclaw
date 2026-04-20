---
summary: "健康检查命令和网关健康监控"
read_when:
  - 诊断通道连接或网关健康状况
  - 了解健康检查 CLI 命令和选项
title: "健康检查"
---

# 健康检查（CLI）

无需猜测即可验证通道连接的简短指南。

## 快速检查

- `openclaw status` — 本地摘要：网关可达性/模式、更新提示、链接的通道身份验证年龄、会话 + 最近活动。
- `openclaw status --all` — 完整的本地诊断（只读、彩色、安全粘贴用于调试）。
- `openclaw status --deep` — 向运行中的网关请求实时健康探测（`health` 与 `probe:true`），包括支持时的每账户通道探测。
- `openclaw health` — 向运行中的网关请求其健康快照（仅 WS；CLI 无直接通道套接字）。
- `openclaw health --verbose` — 强制实时健康探测并打印网关连接详细信息。
- `openclaw health --json` — 机器可读的健康快照输出。
- 在 WhatsApp/WebChat 中发送 `/status` 作为独立消息，无需调用代理即可获得状态回复。
- 日志：尾随 `/tmp/openclaw/openclaw-*.log` 并过滤 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度诊断

- 磁盘上的凭据：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（mtime 应该是最近的）。
- 会话存储：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（路径可以在配置中覆盖）。计数和最近的收件人通过 `status` 显示。
- 重新链接流程：当日志中出现状态码 409–515 或 `loggedOut` 时，使用 `openclaw channels logout && openclaw channels login --verbose`。（注意：QR 登录流程在配对后会为状态 515 自动重启一次。）

## 健康监控配置

- `gateway.channelHealthCheckMinutes`：网关检查通道健康状况的频率。默认值：`5`。设置为 `0` 以全局禁用健康监控重启。
- `gateway.channelStaleEventThresholdMinutes`：连接的通道在健康监控将其视为陈旧并重启之前可以保持空闲的时间。默认值：`30`。保持此值大于或等于 `gateway.channelHealthCheckMinutes`。
- `gateway.channelMaxRestartsPerHour`：每个通道/账户的健康监控重启的每小时滚动上限。默认值：`10`。
- `channels.<provider>.healthMonitor.enabled`：禁用特定通道的健康监控重启，同时保持全局监控启用。
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`：多账户覆盖，优先于通道级设置。
- 这些每通道覆盖适用于今天公开它们的内置通道监控器：Discord、Google Chat、iMessage、Microsoft Teams、Signal、Slack、Telegram 和 WhatsApp。

## 当出现故障时

- `logged out` 或状态 409–515 → 使用 `openclaw channels logout` 然后 `openclaw channels login` 重新链接。
- 网关不可达 → 启动它：`openclaw gateway --port 18789`（如果端口繁忙，使用 `--force`）。
- 无入站消息 → 确认链接的手机在线且发件人被允许（`channels.whatsapp.allowFrom`）；对于群组聊天，确保允许列表 + 提及规则匹配（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 专用的"health"命令

`openclaw health` 向运行中的网关请求其健康快照（CLI 无直接通道套接字）。默认情况下，它可以返回新鲜的缓存网关快照；然后网关在后台刷新该缓存。`openclaw health --verbose` 强制使用实时探测。该命令在可用时报告链接的凭据/身份验证年龄、每通道探测摘要、会话存储摘要和探测持续时间。如果网关不可达或探测失败/超时，它会以非零状态退出。

选项：

- `--json`：机器可读的 JSON 输出
- `--timeout <ms>`：覆盖默认的 10s 探测超时
- `--verbose`：强制实时探测并打印网关连接详细信息
- `--debug`：`--verbose` 的别名

健康快照包括：`ok`（布尔值）、`ts`（时间戳）、`durationMs`（探测时间）、每通道状态、代理可用性和会话存储摘要。