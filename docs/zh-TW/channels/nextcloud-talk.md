---
summary: "Nextcloud Talk 支援狀態、功能與設定"
read_when:
  - 開發 Nextcloud Talk 頻道功能時
title: "Nextcloud Talk"
---

# Nextcloud Talk (外掛程式)

狀態：透過外掛程式 (webhook 機器人) 支援。支援私訊、房間、表情符號回應 (reactions) 與 Markdown 訊息。

## 需要外掛程式

Nextcloud Talk 以外掛程式形式提供，未包含在核心安裝包中。

透過 CLI 安裝 (npm 註冊表)：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

本地檢出 (從 git 存放庫執行時)：

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

如果您在設定/新手導覽期間選擇 Nextcloud Talk，且偵測到 git 檢出，OpenClaw 將自動提供本地安裝路徑。

詳情：[Plugins](/tools/plugin)

## 快速設定 (初學者)

1. 安裝 Nextcloud Talk 外掛程式。
2. 在您的 Nextcloud 伺服器上建立一個機器人：

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. 在目標房間設定中啟用該機器人。
4. 設定 OpenClaw：
   - 設定：`channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或環境變數：`NEXTCLOUD_TALK_BOT_SECRET` (僅限預設帳號)
5. 重新啟動 Gateway (或完成新手導覽)。

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

- 機器人無法主動發起私訊。使用者必須先傳送訊息給機器人。
- Webhook URL 必須可由 Gateway 存取；若位於代理伺服器後方，請設定 `webhookPublicUrl`。
- 機器人 API 不支援媒體上傳；媒體將以 URL 形式傳送。
- Webhook 承載資料 (payload) 無法區分私訊或房間；設定 `apiUser` + `apiPassword` 以啟用房間類型查詢 (否則私訊將被視為房間)。

## 存取控制 (私訊)

- 預設：`channels.nextcloud-talk.dmPolicy = "pairing"`。未知的傳送者將獲得配對碼。
- 核准方式：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開私訊：`channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` 僅比對 Nextcloud 使用者 ID；顯示名稱會被忽略。

## 房間 (群組)

- 預設：`channels.nextcloud-talk.groupPolicy = "allowlist"` (由提及門檻控管)。
- 使用 `channels.nextcloud-talk.rooms` 將房間加入允許清單：

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

## 功能支援

| 功能         | 狀態     |
| ------------ | -------- |
| 私訊         | 已支援   |
| 房間         | 已支援   |
| 對話串       | 未支援   |
| 媒體         | 僅限 URL |
| 表情符號回應 | 已支援   |
| 原生指令     | 未支援   |

## 設定參考 (Nextcloud Talk)

完整設定：[設定](/gateway/configuration)

供應商選項：

- `channels.nextcloud-talk.enabled`：啟用/停用頻道啟動。
- `channels.nextcloud-talk.baseUrl`：Nextcloud 實例 URL。
- `channels.nextcloud-talk.botSecret`：機器人共享金鑰。
- `channels.nextcloud-talk.botSecretFile`：金鑰檔案路徑。
- `channels.nextcloud-talk.apiUser`：用於房間查詢的 API 使用者 (私訊偵測)。
- `channels.nextcloud-talk.apiPassword`：用於房間查詢的 API/應用程式密碼。
- `channels.nextcloud-talk.apiPasswordFile`：API 密碼檔案路徑。
- `channels.nextcloud-talk.webhookPort`：Webhook 監聽埠 (預設：8788)。
- `channels.nextcloud-talk.webhookHost`：Webhook 主機 (預設：0.0.0.0)。
- `channels.nextcloud-talk.webhookPath`：Webhook 路徑 (預設：/nextcloud-talk-webhook)。
- `channels.nextcloud-talk.webhookPublicUrl`：外部可存取的 Webhook URL。
- `channels.nextcloud-talk.dmPolicy`：`pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`：私訊允許清單 (使用者 ID)。`open` 需要 `"*"`。
- `channels.nextcloud-talk.groupPolicy`：`allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`：群組允許清單 (使用者 ID)。
- `channels.nextcloud-talk.rooms`：個別房間設定與允許清單。
- `channels.nextcloud-talk.historyLimit`：群組歷史紀錄限制 (0 表示停用)。
- `channels.nextcloud-talk.dmHistoryLimit`：私訊歷史紀錄限制 (0 表示停用)。
- `channels.nextcloud-talk.dms`：個別私訊覆寫 (historyLimit)。
- `channels.nextcloud-talk.textChunkLimit`：外發文字區塊大小 (字元)。
- `channels.nextcloud-talk.chunkMode`：`length` (預設) 或 `newline` (在長度切分前先按空白行/段落邊界切分)。
- `channels.nextcloud-talk.blockStreaming`：停用此頻道的區塊串流傳輸。
- `channels.nextcloud-talk.blockStreamingCoalesce`：區塊串流傳輸合併調整。
- `channels.nextcloud-talk.mediaMaxMb`：內送媒體上限 (MB)。
