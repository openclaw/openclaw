---
summary: "「openclaw channels」的 CLI 參考（帳號、狀態、登入／登出、日誌）"
read_when:
  - 你想要新增／移除頻道帳號（WhatsApp／Telegram／Discord／Google Chat／Slack／Mattermost（外掛）／Signal／iMessage）
  - 你想要檢查頻道狀態或即時查看頻道日誌
title: "頻道"
---

# `openclaw channels`

在 Gateway 閘道器上管理聊天頻道帳號及其執行期狀態。

Related docs:

- 頻道指南：[Channels](/channels/index)
- Gateway 閘道器設定：[Configuration](/gateway/configuration)

## 常用指令

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## 新增／移除帳號

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

提示：`openclaw channels add --help` 會顯示各頻道專用的旗標（權杖、應用程式權杖、 signal-cli 路徑等）。

## 登入／登出（互動式）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Troubleshooting

- 執行 `openclaw status --deep` 進行全面檢測。
- 使用 `openclaw doctor` 取得引導式修復。
- `openclaw channels list` 會列印 `Claude: HTTP 403 ... user:profile` → usage snapshot needs the `user:profile` scope. user:profile`→ 使用快照需要`user:profile`範圍。請使用`--no-usage`，或提供 claude.ai 工作階段金鑰（`CLAUDE_WEB_SESSION_KEY`／`CLAUDE_WEB_COOKIE\`），或透過 Claude Code CLI 重新驗證。

## 能力探測

擷取提供者的能力提示（在可用時包含 intents／scopes）以及靜態功能支援：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注意事項：

- `--channel` 為選用；省略即可列出所有頻道（包含擴充）。
- `--target` 接受 `channel:<id>` 或原始的數字頻道 ID，且僅適用於 Discord。
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## 將名稱解析為 ID

使用提供者目錄將頻道／使用者名稱解析為 ID：

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

注意事項：

- 使用 `--kind user|group|auto` 強制指定目標類型。
- Resolution prefers active matches when multiple entries share the same name.
