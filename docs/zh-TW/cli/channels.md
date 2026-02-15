---
summary: "openclaw channels 的 CLI 參考文件（帳號、狀態、登入/登出、日誌）"
read_when:
  - 您想要新增/移除頻道帳號（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage）
  - 您想要檢查頻道狀態或追蹤頻道日誌
title: "channels"
---

# `openclaw channels`

在 Gateway 上管理通訊頻道帳號及其執行狀態。

相關文件：

- 頻道指南：[Channels](/channels/index)
- Gateway 設定：[Configuration](/gateway/configuration)

## 常用指令

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" " @jane"
openclaw channels logs --channel all
```

## 新增 / 移除帳號

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

提示：`openclaw channels add --help` 會顯示各個頻道的標記（token, app token, signal-cli 路徑等）。

## 登入 / 登出（互動式）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 疑難排解

- 執行 `openclaw status --deep` 進行全面探測。
- 使用 `openclaw doctor` 進行引導式修復。
- 若 `openclaw channels list` 顯示 `Claude: HTTP 403 ... user:profile` → 表示使用量快照需要 `user:profile` 範圍。請使用 `--no-usage`，或提供 claude.ai 工作階段金鑰 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`)，或透過 Claude Code CLI 重新驗證。

## 功能探測

獲取供應商功能提示（可用的 intents/scopes）以及靜態功能支援：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注意事項：

- `--channel` 是選填的；省略它將列出所有頻道（包含擴充功能）。
- `--target` 接受 `channel:<id>` 或原始數字頻道 ID，且僅適用於 Discord。
- 探測是特定於供應商的：Discord intents + 選填的頻道權限；Slack bot + 使用者範圍；Telegram bot 標記 + webhook；Signal daemon 版本；MS Teams app token + Graph 角色/範圍（已知處有標註）。沒有探測功能的頻道會回報 `Probe: unavailable`。

## 將名稱解析為 ID

使用供應商目錄將頻道/使用者名稱解析為 ID：

```bash
openclaw channels resolve --channel slack "#general" " @jane"
openclaw channels resolve --channel discord "My Server/#support" " @someone"
openclaw channels resolve --channel matrix "Project Room"
```

注意事項：

- 使用 `--kind user|group|auto` 強制指定目標類型。
- 當多個項目名稱相同時，解析會優先選擇活躍的相符項。
