---
summary: "Nextcloud Talk support status, capabilities, and configuration"
read_when:
  - Working on Nextcloud Talk channel features
title: Nextcloud Talk
---

# Nextcloud Talk (插件)

狀態：透過插件（webhook 機器人）支援。支援直接訊息、房間、反應和 Markdown 訊息。

## 需要插件

Nextcloud Talk 作為一個插件發佈，並不與核心安裝一起捆綁。

透過 CLI 安裝（npm 註冊表）：

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

[[BLOCK_1]]  
本地檢出（當從 git 倉庫執行時）：  
[[BLOCK_1]]

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

如果您在設定/入門過程中選擇 Nextcloud Talk，並且檢測到 git checkout，OpenClaw 將自動提供本地安裝路徑。

[[INLINE_1]]

## 快速設置（初學者）

1. 安裝 Nextcloud Talk 外掛。
2. 在你的 Nextcloud 伺服器上，創建一個機器人：

```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
```

3. 在目標房間設定中啟用機器人。
4. 設定 OpenClaw：
   - 設定: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - 或環境: `NEXTCLOUD_TALK_BOT_SECRET`（僅限預設帳戶）
5. 重新啟動網關（或完成上線流程）。

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

## Notes

- 機器人無法主動發送私訊。使用者必須先發送訊息給機器人。
- Webhook URL 必須能被 Gateway 訪問；如果在代理伺服器後面，請設置 `webhookPublicUrl`。
- 機器人 API 不支援媒體上傳；媒體以 URL 形式發送。
- Webhook 負載不區分私訊與房間；設置 `apiUser` + `apiPassword` 以啟用房間類型查詢（否則私訊將被視為房間）。

## 存取控制 (DMs)

- 預設: `channels.nextcloud-talk.dmPolicy = "pairing"`。未知發送者會獲得配對碼。
- 通過以下方式批准：
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- 公開私訊: `channels.nextcloud-talk.dmPolicy="open"` 加上 `channels.nextcloud-talk.allowFrom=["*"]`。
- `allowFrom` 僅匹配 Nextcloud 使用者 ID；顯示名稱會被忽略。

## Rooms (groups)

- 預設: `channels.nextcloud-talk.groupPolicy = "allowlist"` (提及限制)。
- 允許清單房間使用 `channels.nextcloud-talk.rooms`:

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

- 若要不允許任何房間，請保持允許清單為空或設置 `channels.nextcloud-talk.groupPolicy="disabled"`。

## Capabilities

| 功能     | 狀態     |
| -------- | -------- |
| 直接訊息 | 支援     |
| 房間     | 支援     |
| 主題     | 不支援   |
| 媒體     | 僅限 URL |
| 反應     | 支援     |
| 原生指令 | 不支援   |

## 設定參考 (Nextcloud Talk)

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.nextcloud-talk.enabled`: 啟用/禁用頻道啟動。
- `channels.nextcloud-talk.baseUrl`: Nextcloud 實例 URL。
- `channels.nextcloud-talk.botSecret`: 機器人共享密鑰。
- `channels.nextcloud-talk.botSecretFile`: 正常檔案密鑰路徑。符號連結會被拒絕。
- `channels.nextcloud-talk.apiUser`: 用於房間查詢的 API 使用者（DM 偵測）。
- `channels.nextcloud-talk.apiPassword`: 用於房間查詢的 API/應用程式密碼。
- `channels.nextcloud-talk.apiPasswordFile`: API 密碼檔案路徑。
- `channels.nextcloud-talk.webhookPort`: webhook 監聽埠（預設：8788）。
- `channels.nextcloud-talk.webhookHost`: webhook 主機（預設：0.0.0.0）。
- `channels.nextcloud-talk.webhookPath`: webhook 路徑（預設：/nextcloud-talk-webhook）。
- `channels.nextcloud-talk.webhookPublicUrl`: 可從外部訪問的 webhook URL。
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`。
- `channels.nextcloud-talk.allowFrom`: DM 允許清單（使用者 ID）。`open` 需要 `"*"`。
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`。
- `channels.nextcloud-talk.groupAllowFrom`: 群組允許清單（使用者 ID）。
- `channels.nextcloud-talk.rooms`: 每個房間的設定和允許清單。
- `channels.nextcloud-talk.historyLimit`: 群組歷史限制（0 禁用）。
- `channels.nextcloud-talk.dmHistoryLimit`: DM 歷史限制（0 禁用）。
- `channels.nextcloud-talk.dms`: 每個 DM 的覆蓋設定（historyLimit）。
- `channels.nextcloud-talk.textChunkLimit`: 外發文字塊大小（字元）。
- `channels.nextcloud-talk.chunkMode`: `length`（預設）或 `newline` 在長度分塊之前按空白行（段落邊界）進行分割。
- `channels.nextcloud-talk.blockStreaming`: 禁用此頻道的區塊串流。
- `channels.nextcloud-talk.blockStreamingCoalesce`: 區塊串流合併調整。
- `channels.nextcloud-talk.mediaMaxMb`: 入站媒體上限（MB）。
