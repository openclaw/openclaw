---
summary: "Mattermost bot 設定與 OpenClaw 設定"
read_when:
  - 設定 Mattermost
  - 偵錯 Mattermost 路由
title: "Mattermost"
---

# Mattermost (外掛程式)

狀態：透過外掛程式支援 (bot token + WebSocket events)。支援頻道、群組和私訊。
Mattermost 是一個可自行託管的團隊訊息平台；請參閱 [mattermost.com](https://mattermost.com) 官方網站，了解產品詳細資訊和下載。

## 需要外掛程式

Mattermost 作為外掛程式提供，不與核心安裝程式綁定。

透過 CLI 安裝 (npm 登錄檔)：

```bash
openclaw plugins install @openclaw/mattermost
```

本地結帳 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/mattermost
```

如果您在設定/新手導覽期間選擇 Mattermost，並且偵測到 git 結帳，OpenClaw 將自動提供本地安裝路徑。

詳細資訊：[外掛程式](/tools/plugin)

## 快速設定

1. 安裝 Mattermost 外掛程式。
2. 建立一個 Mattermost bot 帳戶並複製 **bot 權杖**。
3. 複製 Mattermost **基礎 URL** (例如，`https://chat.example.com`)。
4. 設定 OpenClaw 並啟動 Gateway。

最簡設定：

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 環境變數 (預設帳戶)

如果您偏好環境變數，請在 Gateway 主機上設定這些：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境變數僅適用於 **預設** 帳戶 (`default`)。其他帳戶必須使用設定值。

## 聊天模式

Mattermost 會自動回應私訊。頻道行為由 `chatmode` 控制：

- `oncall` (預設)：僅當在頻道中被提及時回應。
- `onmessage`：回應每個頻道訊息。
- `onchar`：當訊息以觸發前綴開頭時回應。

設定範例：

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

注意事項：

- `onchar` 仍然會回應明確的 @提及。
- `channels.mattermost.requireMention` 對於舊版設定仍然有效，但偏好使用 `chatmode`。

## 存取控制 (私訊)

- 預設：`channels.mattermost.dmPolicy = "pairing"` (未知寄件者會收到配對碼)。
- 透過以下方式核准：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開私訊：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## 頻道 (群組)

- 預設：`channels.mattermost.groupPolicy = "allowlist"` (提及限制)。
- 使用 `channels.mattermost.groupAllowFrom` 允許清單中的寄件者 (使用者 ID 或 ` @username`)。
- 開放頻道：`channels.mattermost.groupPolicy="open"` (提及限制)。

## 用於出站遞送的目標

將這些目標格式與 `openclaw message send` 或 cron/網路掛鉤搭配使用：

- `channel:<id>` 用於頻道
- `user:<id>` 用於私訊
- ` @username` 用於私訊 (透過 Mattermost API 解析)

單獨的 ID 會被視為頻道。

## 多帳戶

Mattermost 在 `channels.mattermost.accounts` 下支援多個帳戶：

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "主要", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "警報", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 疑難排解

- 頻道中沒有回應：確保 bot 在頻道中並提及它 (oncall)，使用觸發前綴 (onchar)，或設定 `chatmode: "onmessage"`。
- 驗證錯誤：檢查 bot 權杖、基礎 URL，以及帳戶是否已啟用。
- 多帳戶問題：環境變數僅適用於 `預設` 帳戶。
