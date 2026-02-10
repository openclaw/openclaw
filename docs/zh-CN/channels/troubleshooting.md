---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 渠道已连接但消息无法流通（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 排查渠道配置错误（意图、权限、隐私模式）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: 渠道专属故障排除快捷指南（Discord/Telegram/WhatsApp）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: 渠道故障排除（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-01T19:58:09Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 6542ee86b3e50929caeaab127642d135dfbc0d8a44876ec2df0fff15bf57cd63（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: channels/troubleshooting.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 14（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 渠道故障排除（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
首先运行：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels status --probe` 会在检测到常见渠道配置错误时输出警告，并包含小型实时检查（凭据、部分权限/成员资格）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 渠道（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord：[/channels/discord#troubleshooting](/channels/discord#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram：[/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp：[/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Telegram 快速修复（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 日志显示 `HttpError: Network request for 'sendMessage' failed` 或 `sendChatAction` → 检查 IPv6 DNS。如果 `api.telegram.org` 优先解析为 IPv6 而主机缺少 IPv6 出站连接，请强制使用 IPv4 或启用 IPv6。参见 [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 日志显示 `setMyCommands failed` → 检查到 `api.telegram.org` 的出站 HTTPS 和 DNS 可达性（常见于限制严格的 VPS 或代理环境）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
