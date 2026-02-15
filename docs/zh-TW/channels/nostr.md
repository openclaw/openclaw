---
summary: "透過 NIP-04 加密訊息的 Nostr 私訊通道"
read_when:
  - 您希望 OpenClaw 透過 Nostr 接收私訊
  - 您正在設定去中心化通訊
title: "Nostr"
---

# Nostr

**狀態：** 選用外掛（預設禁用）。

Nostr 是一個去中心化的社群網路協定。此通道讓 OpenClaw 能夠透過 NIP-04 接收並回覆加密的私訊 (DMs)。

## 安裝（按需安裝）

### 新手導覽（推薦）

- 新手導覽精靈 (`openclaw onboard`) 與 `openclaw channels add` 會列出選用的通道外掛。
- 選擇 Nostr 會提示您按需安裝此外掛。

安裝預設值：

- **開發通道 + 可使用 git checkout：** 使用本地外掛路徑。
- **穩定版/測試版 (Stable/Beta)：** 從 npm 下載。

您隨時可以在提示中覆蓋此選擇。

### 手動安裝

```bash
openclaw plugins install @openclaw/nostr
```

使用本地檢出（開發工作流）：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

安裝或啟用外掛後，請重新啟動 Gateway。

## 快速設定

1. 產生 Nostr 金鑰對（如果需要）：

```bash
# 使用 nak
nak key generate
```

2. 新增至設定：

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. 匯出金鑰：

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 重新啟動 Gateway。

## 設定參考

| 鍵名         | 類型     | 預設值                                      | 描述                               |
| ------------ | -------- | ------------------------------------------- | ---------------------------------- |
| `privateKey` | string   | 必填                                        | `nsec` 或十六進制格式的私鑰        |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中繼站 URL (WebSocket)             |
| `dmPolicy`   | string   | `pairing`                                   | 私訊存取策略                       |
| `allowFrom`  | string[] | `[]`                                        | 允許的傳送者公鑰                   |
| `enabled`    | boolean  | `true`                                      | 啟用/禁用通道                      |
| `name`       | string   | -                                           | 顯示名稱                           |
| `profile`    | object   | -                                           | NIP-01 個人資料詮釋資料 (metadata) |

## 個人資料詮釋資料

個人資料會以 NIP-01 `kind:0` 事件發佈。您可以從控制介面 (Channels -> Nostr -> Profile) 進行管理，或直接在設定中設定。

範例：

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "個人助理私訊機器人",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

附註：

- 個人資料 URL 必須使用 `https://`。
- 從中繼站匯入會合併欄位並保留本地覆蓋。

## 存取控制

### 私訊策略

- **pairing** (預設)：未知的傳送者會收到配對碼。
- **allowlist**：只有 `allowFrom` 中的公鑰可以傳送私訊。
- **open**：開放外部私訊（需要設定 `allowFrom: ["*"]`）。
- **disabled**：忽略傳入的私訊。

### 白名單範例

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## 金鑰格式

接受的格式：

- **私鑰：** `nsec...` 或 64 字元的十六進制格式
- **公鑰 (`allowFrom`)：** `npub...` 或十六進制格式

## 中繼站 (Relays)

預設值：`relay.damus.io` 與 `nos.lol`。

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

提示：

- 使用 2-3 個中繼站以確保冗餘。
- 避免使用過多中繼站（延遲、重複）。
- 付費中繼站可以提高可靠性。
- 本地中繼站適用於測試 (`ws://localhost:7777`)。

## 協定支援

| NIP    | 狀態   | 描述                              |
| ------ | ------ | --------------------------------- |
| NIP-01 | 已支援 | 基本事件格式 + 個人資料詮釋資料   |
| NIP-04 | 已支援 | 加密私訊 (`kind:4`)               |
| NIP-17 | 計畫中 | 禮物包裝式私訊 (Gift-wrapped DMs) |
| NIP-44 | 計畫中 | 版本化加密                        |

## 測試

### 本地中繼站

```bash
# 啟動 strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### 手動測試

1. 從記錄中記下機器人的公鑰 (npub)。
2. 開啟 Nostr 用戶端（如 Damus, Amethyst 等）。
3. 傳送私訊給機器人公鑰。
4. 驗證回覆。

## 疑難排解

### 無法接收訊息

- 驗證私鑰是否有效。
- 確保中繼站 URL 可連接，且使用 `wss://`（本地則使用 `ws://`）。
- 確認 `enabled` 未設定為 `false`。
- 檢查 Gateway 記錄中是否有中繼站連線錯誤。

### 無法傳送回覆

- 檢查中繼站是否接受寫入。
- 驗證對外連線性。
- 注意中繼站的頻率限制 (rate limits)。

### 重複回覆

- 使用多個中繼站時為預期現象。
- 訊息會根據事件 ID 進行去重；只有第一次送達會觸發回覆。

## 安全性

- 絕不要提交私鑰。
- 使用環境變數來管理金鑰。
- 對於生產環境的機器人，請考慮使用 `allowlist`。

## 限制 (MVP)

- 僅限私訊（無群組聊天）。
- 無媒體附件。
- 僅限 NIP-04（計畫支援 NIP-17 禮物包裝）。
