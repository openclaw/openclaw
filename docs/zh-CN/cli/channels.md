---
read_when:
  - 你想添加/移除渠道账号（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（插件）/Signal/iMessage）
  - 你想检查渠道状态或查看渠道日志
summary: "`openclaw channels` 的 CLI 参考（账号、状态、登录/登出、日志）"
title: channels
x-i18n:
  generated_at: "2026-02-01T19:58:48Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 16ab1642f247bfa96e8e08dfeb1eedfccb148f40d91099f5423f971df2b54e20
  source_path: cli/channels.md
  workflow: 14
---

# `openclaw channels`

管理 Gateway网关上的聊天渠道账号及其运行时状态。

相关文档：

- 渠道指南：[渠道](/channels/index)
- Gateway网关配置：[配置](/gateway/configuration)

## 常用命令

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 添加/移除账号

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

提示：`openclaw channels add --help` 可查看各渠道的专用参数（token、app token、signal-cli 路径等）。

## 登录/登出（交互式）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 故障排除

- 运行 `openclaw status --deep` 进行全面探测。
- 使用 `openclaw doctor` 获取引导式修复。
- `openclaw channels list` 输出 `Claude: HTTP 403 ... user:profile` → 用量快照需要 `user:profile` 权限范围。使用 `--no-usage`，或提供 claude.ai 会话密钥（`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`），或通过 Claude Code CLI 重新认证。

## 能力探测

获取提供商能力提示（可用的 intents/scopes）以及静态功能支持：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

说明：

- `--channel` 是可选的；省略时将列出所有渠道（包括扩展）。
- `--target` 接受 `channel:<id>` 或原始数字频道 ID，仅适用于 Discord。
- 探测因提供商而异：Discord intents + 可选的频道权限；Slack bot + 用户权限范围；Telegram bot 标志 + webhook；Signal 守护进程版本；MS Teams 应用令牌 + Graph 角色/权限范围（已知的会标注）。无探测功能的渠道会报告 `Probe: unavailable`。

## 将名称解析为 ID

使用提供商目录将渠道/用户名称解析为 ID：

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

说明：

- 使用 `--kind user|group|auto` 强制指定目标类型。
- 当多个条目共享相同名称时，解析优先选择活跃的匹配项。
