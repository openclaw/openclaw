---
summary: "CLI 參考資料，適用於 `openclaw channels` (帳戶、狀態、登入/登出、日誌)"
read_when:
  - 當您想新增/移除頻道帳戶時 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (外掛程式)/Signal/iMessage)
  - 當您想檢查頻道狀態或追蹤頻道日誌時
title: "channels"
---

# `openclaw channels`

管理 Gateway 上的聊天頻道帳戶及其執行階段狀態。

相關文件：

- 頻道指南：[Channels](/channels/index)
- Gateway 設定：[Configuration](/gateway/configuration)

## 常用命令

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" " @jane"
openclaw channels logs --channel all
```

## 新增/移除帳戶

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

提示：`openclaw channels add --help` 會顯示各頻道的旗標 (token, 應用程式 token, signal-cli 路徑等)。

## 登入/登出 (互動式)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## 疑難排解

- 執行 `openclaw status --deep` 以進行廣泛偵測。
- 使用 `openclaw doctor` 進行引導式修復。
- `openclaw channels list` 列印 `Claude: HTTP 403 ... user:profile` → 使用快照需要 `user:profile` 範圍。使用 `--no-usage`，或提供 claude.ai 工作階段金鑰 (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`)，或透過 Claude Code CLI 重新認證。

## 功能偵測

取得供應商功能提示 (如果可用，包括意圖/範圍) 以及靜態功能支援：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注意事項：

- `--channel` 是選用的；省略它會列出所有頻道 (包括擴充功能)。
- `--target` 接受 `channel:<id>` 或原始的數字頻道 ID，並且僅適用於 Discord。
- 偵測是供應商特定的：Discord 意圖 + 選用頻道權限；Slack bot + 使用者範圍；Telegram bot 旗標 + webhook；Signal daemon 版本；MS Teams 應用程式 token + Graph 角色/範圍 (已知的部分會加註)。沒有偵測的頻道會回報 `Probe: unavailable`。

## 將名稱解析為 ID

使用供應商目錄將頻道/使用者名稱解析為 ID：

```bash
openclaw channels resolve --channel slack "#general" " @jane"
openclaw channels resolve --channel discord "My Server/#support" " @someone"
openclaw channels resolve --channel matrix "Project Room"
```

注意事項：

- 使用 `--kind user|group|auto` 來強制目標類型。
- 當多個項目共用相同名稱時，解析會優先選擇活躍匹配。
