---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 你想添加/删除渠道账户（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 你想检查渠道状态或跟踪渠道日志（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "`openclaw channels` 的 CLI 参考（账户、状态、登录/登出、日志）"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
x-i18n:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  generated_at: "2026-02-03T07:44:51Z"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: claude-opus-4-5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: pi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_hash: 16ab1642f247bfa96e8e08dfeb1eedfccb148f40d91099f5423f971df2b54e20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source_path: cli/channels.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workflow: 15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw channels`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
管理 Gateway 网关上的聊天渠道账户及其运行时状态。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
相关文档：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 渠道指南：[渠道](/channels/index)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway 网关配置：[配置](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 常用命令（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities --channel discord --target channel:123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel slack "#general" "@jane"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logs --channel all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 添加/删除账户（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add --channel telegram --token <bot-token>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels remove --channel telegram --delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
提示：`openclaw channels add --help` 显示每个渠道的标志（token、app token、signal-cli 路径等）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 登录/登出（交互式）（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logout --channel whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 故障排除（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 运行 `openclaw status --deep` 进行全面探测。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用 `openclaw doctor` 获取引导式修复。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels list` 输出 `Claude: HTTP 403 ... user:profile` → 用量快照需要 `user:profile` 权限范围。使用 `--no-usage`，或提供 claude.ai 会话密钥（`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`），或通过 Claude Code CLI 重新授权。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 能力探测（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
获取提供商能力提示（可用的 intents/scopes）以及静态功能支持：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels capabilities --channel discord --target channel:123（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
说明：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel` 是可选的；省略它可列出所有渠道（包括扩展）。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--target` 接受 `channel:<id>` 或原始数字频道 id，仅适用于 Discord。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 探测是特定于提供商的：Discord intents + 可选的频道权限；Slack bot + user scopes；Telegram bot 标志 + webhook；Signal daemon 版本；MS Teams app token + Graph roles/scopes（在已知处标注）。没有探测功能的渠道报告 `Probe: unavailable`。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 解析名称为 ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
使用提供商目录将渠道/用户名称解析为 ID：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel slack "#general" "@jane"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel discord "My Server/#support" "@someone"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels resolve --channel matrix "Project Room"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
说明：（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 使用 `--kind user|group|auto` 强制指定目标类型。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 当多个条目共享相同名称时，解析优先选择活跃的匹配项。（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
