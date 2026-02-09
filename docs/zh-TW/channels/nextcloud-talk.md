---
summary: "Nextcloud Talk 的支援狀態、功能與設定"
read_when:
  - 進行 Nextcloud Talk 頻道功能開發時
title: "Nextcloud Talk"
---

# Nextcloud Talk（外掛）

19. 狀態：透過外掛支援（Webhook 機器人）。 20. 支援私訊、聊天室、反應以及 Markdown 訊息。

## 21. 需要外掛

Nextcloud Talk 以外掛形式提供，未隨核心安裝一併包含。

透過 CLI 安裝（npm registry）：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

本地檢出（從 git 儲存庫執行時）：

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

若在設定／入門引導期間選擇 Nextcloud Talk，且偵測到 git 檢出，
OpenClaw 會自動提供本地安裝路徑。

詳細資訊：[Plugins](/tools/plugin)

## 快速設定（初學者）

1. 安裝 Nextcloud Talk 外掛。

2. 在你的 Nextcloud 伺服器上建立一個機器人：

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 22. 在目標聊天室設定中啟用機器人。

4. 設定 OpenClaw：
   - 設定：`channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或 環境變數：`NEXTCLOUD_TALK_BOT_SECRET`（僅預設帳戶）

5. 23. 重新啟動閘道（或完成上線流程）。

最小設定：

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## 注意事項

- 24. 機器人無法主動發起私訊。 25. 使用者必須先傳訊給機器人。
- Webhook URL 必須可被 Gateway 閘道器存取；若在 Proxy 後方，請設定 `webhookPublicUrl`。
- 機器人 API 不支援媒體上傳；媒體會以 URL 形式傳送。
- 26. Webhook 負載無法區分私訊與聊天室；請設定 `apiUser` + `apiPassword` 以啟用聊天室類型查詢（否則私訊會被視為聊天室）。

## 27. 存取控制（私訊）

- 預設：`channels.nextcloud-talk.dmPolicy = "pairing"`。未知的寄件者會收到配對碼。 28. 未知的寄件者會收到配對碼。
- 29. 核准方式：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開私訊：`channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` 僅比對 Nextcloud 使用者 ID；顯示名稱會被忽略。

## 房間（群組）

- 預設：`channels.nextcloud-talk.groupPolicy = "allowlist"`（需提及才回應）。
- 使用 `channels.nextcloud-talk.rooms` 允許特定房間：

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- 若不允許任何房間，請保持允許清單為空，或設定 `channels.nextcloud-talk.groupPolicy="disabled"`。

## 功能

| 功能                            | Status |
| ----------------------------- | ------ |
| 30. 私訊 | 支援     |
| 房間                            | 支援     |
| 討論串                           | 不支援    |
| 媒體                            | 僅 URL  |
| 反應                            | 支援     |
| 原生命令                          | 不支援    |

## 設定參考（Nextcloud Talk）

完整設定：[Configuration](/gateway/configuration)

提供者選項：

- `channels.nextcloud-talk.enabled`：啟用／停用頻道啟動。
- `channels.nextcloud-talk.baseUrl`：Nextcloud 執行個體 URL。
- `channels.nextcloud-talk.botSecret`：機器人共用密鑰。
- `channels.nextcloud-talk.botSecretFile`：密鑰檔案路徑。
- `channels.nextcloud-talk.apiUser`：用於房間查詢的 API 使用者（私訊偵測）。
- `channels.nextcloud-talk.apiPassword`：用於房間查詢的 API／應用程式密碼。
- `channels.nextcloud-talk.apiPasswordFile`：API 密碼檔案路徑。
- `channels.nextcloud-talk.webhookPort`：Webhook 監聽連接埠（預設：8788）。
- `channels.nextcloud-talk.webhookHost`：Webhook 主機（預設：0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`：Webhook 路徑（預設：/nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`：對外可存取的 Webhook URL。
- `channels.nextcloud-talk.dmPolicy`：`pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`：私訊允許清單（使用者 ID）。`open` 需要 `"*"`。 31. `open` 需要使用 `"*"`。
- `channels.nextcloud-talk.groupPolicy`：`allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`：群組允許清單（使用者 ID）。
- `channels.nextcloud-talk.rooms`：每個房間的設定與允許清單。
- `channels.nextcloud-talk.historyLimit`：群組歷史限制（0 代表停用）。
- `channels.nextcloud-talk.dmHistoryLimit`：私訊歷史限制（0 代表停用）。
- `channels.nextcloud-talk.dms`：每個私訊的覆寫設定（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`：外送文字分段大小（字元）。
- `channels.nextcloud-talk.chunkMode`：`length`（預設）或 `newline`，在依長度分段前先以空行（段落邊界）切分。
- `channels.nextcloud-talk.blockStreaming`：停用此頻道的區塊串流。
- `channels.nextcloud-talk.blockStreamingCoalesce`：區塊串流合併調校。
- `channels.nextcloud-talk.mediaMaxMb`：進站媒體上限（MB）。
