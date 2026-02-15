---
summary: "Mattermost 機器人設定與 OpenClaw 設定"
read_when:
  - 設定 Mattermost 時
  - 對 Mattermost 路由進行除錯時
title: "Mattermost"
---

# Mattermost (外掛)

狀態：透過外掛支援 (機器人權杖 + WebSocket 事件)。支援頻道、群組和私訊。
Mattermost 是一個可自託管的團隊訊息平台；請參閱官方網站 [mattermost.com](https://mattermost.com) 以瞭解產品詳情和下載。

## 需要外掛

Mattermost 以外掛形式提供，並未包含在核心安裝中。

透過 CLI 安裝 (npm 登錄檔)：

```bash
openclaw plugins install @openclaw/mattermost
```

本地檢出 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/mattermost
```

如果您在設定/新手導覽 (onboarding) 期間選擇 Mattermost 且偵測到 git 檢出，OpenClaw 將自動提供本地安裝路徑。

詳情：[外掛](/tools/plugin)

## 快速設定

1. 安裝 Mattermost 外掛。
2. 建立 Mattermost 機器人帳號並複製 **機器人權杖 (bot token)**。
3. 複製 Mattermost **基礎 URL** (例如：`https://chat.example.com`)。
4. 設定 OpenClaw 並啟動 Gateway。

最小化設定：

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

## 環境變數 (預設帳號)

如果您偏好使用環境變數，請在 Gateway 主機上設定這些變數：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

環境變數僅適用於 **預設** 帳號 (`default`)。其他帳號必須使用設定值。

## 聊天模式

Mattermost 會自動回應私訊。頻道的行為由 `chatmode` 控制：

- `oncall` (預設)：僅在頻道中被 @提及時回應。
- `onmessage`：回應每一則頻道訊息。
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

說明：

- `onchar` 仍然會回應明確的 @提及。
- `channels.mattermost.requireMention` 在舊版設定中仍有效，但建議優先使用 `chatmode`。

## 存取控制 (私訊)

- 預設：`channels.mattermost.dmPolicy = "pairing"` (不明傳送者會收到配對碼)。
- 核准方式：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開私訊：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## 頻道 (群組)

- 預設：`channels.mattermost.groupPolicy = "allowlist"` (受提及限制)。
- 使用 `channels.mattermost.groupAllowFrom` (使用者 ID 或 `@username`) 將傳送者加入允許清單。
- 開放頻道：`channels.mattermost.groupPolicy="open"` (受提及限制)。

## 外部傳送目標

搭配 `openclaw message send` 或 cron/webhooks 使用這些目標格式：

- `channel:<id>` 用於頻道
- `user:<id>` 用於私訊
- `@username` 用於私訊 (透過 Mattermost API 解析)

純 ID 會被視為頻道。

## 多帳號

Mattermost 支援在 `channels.mattermost.accounts` 下設定多個帳號：

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 疑難排解

- 頻道中沒有回應：請確保機器人在頻道中並標記它 (oncall)、使用觸發前綴 (onchar)，或設定 `chatmode: "onmessage"`。
- 認證錯誤：檢查機器人權杖 (bot token)、基礎 URL 以及帳號是否已啟用。
- 多帳號問題：環境變數僅適用於 `default` 帳號。
