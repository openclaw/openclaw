---
summary: "Nostr 私訊頻道，透過 NIP-04 加密訊息"
read_when:
  - 您希望 OpenClaw 透過 Nostr 接收私訊
  - 您正在設定去中心化訊息傳輸
title: "Nostr"
---

# Nostr

**狀態：** 可選外掛（預設為停用）。

Nostr 是一個去中心化的社交網路通訊協定。此頻道讓 OpenClaw 能夠透過 NIP-04 接收並回應加密的私訊。

## 安裝 (隨選)

### 新手導覽 (建議)

- 新手導覽精靈 (`openclaw onboard`) 和 `openclaw channels add` 會列出可選的頻道外掛。
- 選擇 Nostr 會提示您隨選安裝該外掛。

預設安裝：

- **開發頻道 + git checkout 可用：** 使用本機外掛路徑。
- **穩定/測試版：** 從 npm 下載。

您隨時可以在提示中覆寫選擇。

### 手動安裝

```bash
openclaw plugins install @openclaw/nostr
```

使用本機 checkout (開發工作流程)：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

安裝或啟用外掛後，請重新啟動 Gateway。

## 快速設定

1. 產生 Nostr 金鑰對（如果需要）：

```bash
# Using nak
nak key generate
```

2. 加入設定：

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

| Key | 類型 | 預設值 | 說明 |
|---|---|---|---|
| `privateKey` | string | required | 以 `nsec` 或十六進位格式表示的私密金鑰 |
| `relays` | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay 網址 (WebSocket) |
| `dmPolicy` | string | `pairing` | 私訊存取政策 |
| `allowFrom` | string[] | `[]` | 允許的寄件者公開金鑰 |
| `enabled` | boolean | `true` | 啟用/停用頻道 |
| `name` | string | - | 顯示名稱 |
| `profile` | object | - | NIP-01 個人檔案中繼資料 |

## 個人檔案中繼資料

個人檔案資料以 NIP-01 `kind:0` 事件發布。您可以從控制介面 (Channels -> Nostr -> Profile) 管理它，或直接在設定中設定。

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
        "nip05": "openclaw @example.com",
        "lud16": "openclaw @example.com"
      }
    }
  }
}
```

注意事項：

- 個人檔案網址必須使用 `https://`。
- 從 relay 匯入會合併欄位並保留本機覆寫。

## 存取控制

### 私訊政策

- **配對** (預設)：未知寄件者會獲得一個配對碼。
- **允許清單**：只有 `allowFrom` 中的公開金鑰可以發送私訊。
- **開放**：公開傳入私訊（需要 `allowFrom: ["*"]`）。
- **停用**：忽略傳入私訊。

### 允許清單範例

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

- **私密金鑰：** `nsec...` 或 64 個字元的十六進位
- **公開金鑰 (`allowFrom`)：** `npub...` 或 十六進位

## Relays

預設值：`relay.damus.io` 和 `nos.lol`。

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

- 使用 2-3 個 relay 以實現冗餘。
- 避免過多 relay（延遲、重複）。
- 付費 relay 可以提高可靠性。
- 本機 relay 適合測試 (`ws://localhost:7777`)。

## 協定支援

| NIP | 狀態 | 說明 |
|---|---|---|
| NIP-01 | 支援 | 基本事件格式 + 個人檔案中繼資料 |
| NIP-04 | 支援 | 加密私訊 (`kind:4`) |
| NIP-17 | 規劃中 | 禮物包裝私訊 |
| NIP-44 | 規劃中 | 版本化加密 |

## 測試

### 本機 Relay

```bash
# Start strfry
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

1. 從日誌中記下機器人的公開金鑰 (npub)。
2. 開啟 Nostr 用戶端（例如 Damus、Amethyst 等）。
3. 向機器人的公開金鑰發送私訊。
4. 驗證回應。

## 疑難排解

### 未收到訊息

- 驗證私密金鑰是否有效。
- 確保 relay 網址可連線並使用 `wss://` (或本機的 `ws://`)。
- 確認 `enabled` 不是 `false`。
- 檢查 Gateway 日誌以查看 relay 連線錯誤。

### 未發送回應

- 檢查 relay 是否接受寫入。
- 驗證對外連線。
- 注意 relay 速率限制。

### 重複回應

- 使用多個 relay 時預期會發生。
- 訊息透過事件 ID 進行去重複；只有第一次傳送會觸發回應。

## 安全性

- 絕不要提交私密金鑰。
- 對於金鑰使用環境變數。
- 考慮在生產機器人中使用 `允許清單`。

## 限制 (最小可行產品)

- 僅限直接訊息（無群組聊天）。
- 無媒體附件。
- 僅限 NIP-04 (NIP-17 禮物包裝功能規劃中)。
