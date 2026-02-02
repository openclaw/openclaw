---
read_when:
  - 诊断 WhatsApp 渠道健康状况
summary: 渠道连接的健康检查步骤
title: 健康检查
x-i18n:
  generated_at: "2026-02-01T20:26:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 74f242e98244c135e1322682ed6b67d70f3b404aca783b1bb5de96a27c2c1b01
  source_path: gateway/health.md
  workflow: 14
---

# 健康检查（CLI）

验证渠道连接状态的简要指南，无需猜测。

## 快速检查

- `openclaw status` — 本地摘要：Gateway网关可达性/模式、更新提示、已关联渠道认证时长、会话 + 近期活动。
- `openclaw status --all` — 完整本地诊断（只读、带颜色、可安全粘贴用于调试）。
- `openclaw status --deep` — 还会探测运行中的 Gateway网关（支持时进行逐渠道探测）。
- `openclaw health --json` — 向运行中的 Gateway网关请求完整健康快照（仅限 WS；不直接访问 Baileys socket）。
- 在 WhatsApp/WebChat 中发送 `/status` 作为独立消息，可获取状态回复而不触发智能体。
- 日志：尾部查看 `/tmp/openclaw/openclaw-*.log` 并过滤 `web-heartbeat`、`web-reconnect`、`web-auto-reply`、`web-inbound`。

## 深度诊断

- 磁盘上的凭证：`ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json`（修改时间应为近期）。
- 会话存储：`ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json`（路径可在配置中覆盖）。计数和近期接收者可通过 `status` 查看。
- 重新关联流程：当日志中出现状态码 409–515 或 `loggedOut` 时，执行 `openclaw channels logout && openclaw channels login --verbose`。（注意：QR 登录流程在配对后遇到状态码 515 时会自动重试一次。）

## 当出现故障时

- `logged out` 或状态码 409–515 → 使用 `openclaw channels logout` 然后 `openclaw channels login` 重新关联。
- Gateway网关不可达 → 启动它：`openclaw gateway --port 18789`（如果端口被占用，使用 `--force`）。
- 没有收到入站消息 → 确认已关联的手机在线且发送者已被允许（`channels.whatsapp.allowFrom`）；对于群聊，确保允许列表 + 提及规则匹配（`channels.whatsapp.groups`、`agents.list[].groupChat.mentionPatterns`）。

## 专用 "health" 命令

`openclaw health --json` 向运行中的 Gateway网关请求其健康快照（CLI 不直接访问渠道 socket）。它会报告已关联凭证/认证时长（如可用）、逐渠道探测摘要、会话存储摘要和探测耗时。如果 Gateway网关不可达或探测失败/超时，则以非零状态码退出。使用 `--timeout <ms>` 可覆盖默认的 10 秒超时。
