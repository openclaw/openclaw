---
summary: "Mattermost 機器人設定與 OpenClaw 設定"
read_when:
  - 設定 Mattermost
  - 偵錯 Mattermost 路由
title: "Mattermost"
---

# Mattermost（外掛）

16. 狀態：透過外掛支援（機器人權杖 + WebSocket 事件）。 17. 支援頻道、群組與私訊。
17. Mattermost 是一個可自行架設的團隊即時通訊平台；產品詳情與下載請參見官方網站
    [mattermost.com](https://mattermost.com)。

## 19. 需要外掛

Mattermost 以外掛形式提供，未隨核心安裝一併提供。

透過 CLI 安裝（npm registry）：

```bash
openclaw plugins install @openclaw/mattermost
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/mattermost
```

若在設定／入門引導期間選擇 Mattermost 且偵測到 git 檢出，
OpenClaw 會自動提供本機安裝路徑。

詳情：[Plugins](/tools/plugin)

## 快速設定

1. 20. 安裝 Mattermost 外掛。
2. 21. 建立一個 Mattermost 機器人帳戶並複製 **機器人權杖**。
3. 複製 Mattermost **基底 URL**（例如：`https://chat.example.com`）。
4. 設定 OpenClaw 並啟動 Gateway 閘道器。

最小設定：

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

## 環境變數（預設帳號）

22. 若偏好使用環境變數，請在閘道主機上設定以下項目：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

23. 環境變數僅適用於 **預設** 帳戶（`default`）。 24. 其他帳戶必須使用設定值。

## 聊天模式

25. Mattermost 會自動回應私訊。 Mattermost 會自動回覆私訊。頻道行為由 `chatmode` 控制：

- `oncall`（預設）：僅在頻道中被 @ 提及時回覆。
- `onmessage`：回覆每一則頻道訊息。
- `onchar`：當訊息以觸發前綴開頭時回覆。

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

- `onchar` 仍會回應明確的 @ 提及。
- `channels.mattermost.requireMention` 會為相容舊版設定而被遵循，但建議使用 `chatmode`。

## 26. 存取控制（私訊）

- 預設：`channels.mattermost.dmPolicy = "pairing"`（未知寄件者會取得配對碼）。
- 27. 透過以下方式核准：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公開私訊：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## 頻道（群組）

- 預設：`channels.mattermost.groupPolicy = "allowlist"`（需提及）。
- 使用 `channels.mattermost.groupAllowFrom` 將寄件者加入允許清單（使用者 ID 或 `@username`）。
- 開放頻道：`channels.mattermost.groupPolicy="open"`（需提及）。

## 外送目標

搭配 `openclaw message send` 或 cron／webhooks 使用以下目標格式：

- `channel:<id>`：頻道
- `user:<id>`：私訊
- `@username`：私訊（透過 Mattermost API 解析）

28. 裸 ID 會被視為頻道。

## 多帳號

Mattermost 在 `channels.mattermost.accounts` 底下支援多個帳號：

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

## 29. 疑難排解

- 頻道沒有回覆：請確認機器人在頻道中並進行提及（oncall）、使用觸發前綴（onchar），或設定 `chatmode: "onmessage"`。
- 30. 驗證錯誤：請檢查機器人權杖、基底 URL，以及帳戶是否已啟用。
- 31. 多帳戶問題：環境變數僅適用於 `default` 帳戶。
