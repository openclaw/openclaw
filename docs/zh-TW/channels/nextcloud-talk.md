---
summary: "Nextcloud Talk 支援狀態、功能與設定"
read_when:
  - 處理 Nextcloud Talk 通道功能時
title: "Nextcloud Talk"
---

# Nextcloud Talk (外掛程式)

狀態：透過外掛程式 (webhook 機器人) 支援。支援直接訊息、聊天室、表情回應和 Markdown 訊息。

## 需要外掛程式

Nextcloud Talk 以外掛程式形式提供，並未與核心安裝程式綑綁。

透過 CLI (npm 登錄檔) 安裝：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

本地結帳 (從 git 儲存庫執行時)：

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

如果您在設定/新手上路期間選擇 Nextcloud Talk，並且偵測到 git 結帳，
OpenClaw 將自動提供本地安裝路徑。

詳細資訊：[外掛程式](/tools/plugin)

## 快速設定 (初學者)

1. 安裝 Nextcloud Talk 外掛程式。
2. 在您的 Nextcloud 伺服器上，建立一個機器人：

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 在目標聊天室設定中啟用機器人。
4. 設定 OpenClaw：
   - 設定檔：`channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或環境變數：`NEXTCLOUD_TALK_BOT_SECRET` (僅限預設帳號)
5. 重新啟動 Gateway (或完成新手上路)。

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

## 備註

- 機器人無法主動發送私訊。使用者必須先向機器人發送訊息。
- Webhook URL 必須可由 Gateway 存取；如果位於代理伺服器後方，請設定 `webhookPublicUrl`。
- Bot API 不支援媒體上傳；媒體會以 URL 形式發送。
- Webhook 酬載不區分私訊和聊天室；設定 `apiUser` + `apiPassword` 可啟用聊天室類型查詢 (否則私訊將被視為聊天室)。

## 存取控制 (私訊)

- 預設：`channels.nextcloud-talk.dmPolicy = "pairing"`。未知發送者會收到配對碼。
- 透過以下方式核准：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開私訊：`channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` 僅匹配 Nextcloud 使用者 ID；顯示名稱會被忽略。

## 聊天室 (群組)

- 預設：`channels.nextcloud-talk.groupPolicy = "allowlist"` (提及限制)。
- 使用 `channels.nextcloud-talk.rooms` 允許聊天室：

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

- 若不允許任何聊天室，請保持允許列表為空或設定 `channels.nextcloud-talk.groupPolicy="disabled"`。

## 功能

| 功能          | 狀態          |
| ------------- | ------------- |
| 直接訊息      | 支援          |
| 聊天室        | 支援          |
| 討論串        | 不支援        |
| 媒體          | 僅限 URL      |
| 表情回應      | 支援          |
| 原生指令      | 不支援        |

## 設定參考 (Nextcloud Talk)

完整設定：[設定](/gateway/configuration)

提供者選項：

- `channels.nextcloud-talk.enabled`：啟用/停用通道啟動。
- `channels.nextcloud-talk.baseUrl`：Nextcloud 實例 URL。
- `channels.nextcloud-talk.botSecret`：機器人共享密鑰。
- `channels.nextcloud-talk.botSecretFile`：密鑰檔案路徑。
- `channels.nextcloud-talk.apiUser`：用於聊天室查詢 (私訊偵測) 的 API 使用者。
- `channels.nextcloud-talk.apiPassword`：用於聊天室查詢的 API/應用程式密碼。
- `channels.nextcloud-talk.apiPasswordFile`：API 密碼檔案路徑。
- `channels.nextcloud-talk.webhookPort`：webhook 監聽埠 (預設：8788)。
- `channels.nextcloud-talk.webhookHost`：webhook 主機 (預設：0.0.0.0)。
- `channels.nextcloud-talk.webhookPath`：webhook 路徑 (預設：/nextcloud-talk-webhook)。
- `channels.nextcloud-talk.webhookPublicUrl`：外部可存取的 webhook URL。
- `channels.nextcloud-talk.dmPolicy`：`pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`：私訊允許列表 (使用者 ID)。`open` 需要 `"*" `。
- `channels.nextcloud-talk.groupPolicy`：`allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`：群組允許列表 (使用者 ID)。
- `channels.nextcloud-talk.rooms`：每個聊天室的設定和允許列表。
- `channels.nextcloud-talk.historyLimit`：群組歷史記錄限制 (0 停用)。
- `channels.nextcloud-talk.dmHistoryLimit`：私訊歷史記錄限制 (0 停用)。
- `channels.nextcloud-talk.dms`：每個私訊的覆寫 (historyLimit)。
- `channels.nextcloud-talk.textChunkLimit`：發送文字區塊大小 (字元)。
- `channels.nextcloud-talk.chunkMode`：`length` (預設) 或 `newline` 以在長度分塊前按空行 (段落邊界) 分割。
- `channels.nextcloud-talk.blockStreaming`：為此通道停用區塊串流。
- `channels.nextcloud-talk.blockStreamingCoalesce`：區塊串流合併調整。
- `channels.nextcloud-talk.mediaMaxMb`：入站媒體上限 (MB)。
