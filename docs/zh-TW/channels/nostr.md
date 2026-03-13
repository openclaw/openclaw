---
summary: Nostr DM channel via NIP-04 encrypted messages
read_when:
  - You want OpenClaw to receive DMs via Nostr
  - You're setting up decentralized messaging
title: Nostr
---

# Nostr

**狀態：** 可選插件（預設為禁用）。

Nostr 是一個去中心化的社交網路協議。此通道使 OpenClaw 能夠透過 NIP-04 接收和回應加密的直接訊息 (DMs)。

## 安裝（按需）

### Onboarding (recommended)

- 入門精靈 (`openclaw onboard`) 和 `openclaw channels add` 列出可選的通道插件。
- 選擇 Nostr 會提示您按需安裝該插件。

安裝預設值：

- **開發頻道 + git checkout 可用：** 使用本地插件路徑。
- **穩定/測試版：** 從 npm 下載。

你可以隨時覆蓋提示中的選擇。

### 手動安裝

```bash
openclaw plugins install @openclaw/nostr
```

使用本地檢出（開發工作流程）：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

安裝或啟用插件後，請重新啟動網關。

## 快速設定

1. 生成 Nostr 金鑰對（如果需要）：

```bash
# Using nak
nak key generate
```

2. 添加到設定：

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

4. 重新啟動網關。

## 設定參考

| Key          | Type   | Default                                     | Description                 |
| ------------ | ------ | ------------------------------------------- | --------------------------- |
| `privateKey` | 字串   | 必填                                        | `nsec` 或十六進位格式的私鑰 |
| `relays`     | 字串[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中繼 URL (WebSocket)        |
| `dmPolicy`   | 字串   | `pairing`                                   | DM 存取政策                 |
| `allowFrom`  | 字串[] | `[]`                                        | 允許的發送者公鑰            |
| `enabled`    | 布林值 | `true`                                      | 啟用/禁用頻道               |
| `name`       | 字串   | -                                           | 顯示名稱                    |
| `profile`    | 物件   | -                                           | NIP-01 個人資料元數據       |

## Profile metadata

個人資料作為 NIP-01 `kind:0` 事件發佈。您可以從控制介面 (Channels -> Nostr -> Profile) 管理它，或直接在設定中設置。

[[BLOCK_1]]

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
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

[[BLOCK_1]]

- 個人資料網址必須使用 `https://`。
- 從中繼匯入會合併欄位並保留本地覆寫。

## 存取控制

### DM 政策

- **配對** (預設): 未知的發送者會獲得一個配對碼。
- **允許清單**: 只有 `allowFrom` 中的公鑰可以發送私訊。
- **開放**: 公開的進入私訊 (需要 `allowFrom: ["*"]`)。
- **已禁用**: 忽略進入的私訊。

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

## 主要格式

接受的格式：

- **私鑰:** `nsec...` 或 64 字元十六進位
- **公鑰 (`allowFrom`):** `npub...` 或十六進位

## Relays

Defaults: `relay.damus.io` 和 `nos.lol`。

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

Tips:

- 使用 2-3 個繼電器以增加冗餘。
- 避免使用過多的繼電器（延遲、重複）。
- 付費的繼電器可以提高可靠性。
- 本地繼電器適合用於測試 (`ws://localhost:7777`)。

## 協議支援

| NIP    | 狀態   | 描述                        |
| ------ | ------ | --------------------------- |
| NIP-01 | 支援   | 基本事件格式 + 設定檔元資料 |
| NIP-04 | 支援   | 加密的私訊 (`kind:4`)       |
| NIP-17 | 計畫中 | 禮物包裝的私訊              |
| NIP-44 | 計畫中 | 版本化加密                  |

## Testing

### Local relay

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

### Manual test

1. 從日誌中記下機器人的公鑰 (npub)。
2. 打開一個 Nostr 用戶端（如 Damus、Amethyst 等）。
3. 私訊機器人的公鑰。
4. 驗證回應。

## 故障排除

### 未收到訊息

- 驗證私鑰是否有效。
- 確保中繼 URL 可達，並使用 `wss://`（或對於本地使用 `ws://`）。
- 確認 `enabled` 不是 `false`。
- 檢查 Gateway 日誌以尋找中繼連接錯誤。

### Not sending responses

- 檢查中繼是否接受寫入。
- 驗證外部連接性。
- 監控中繼速率限制。

### Duplicate responses

- 預期在使用多個中繼時。
- 訊息依事件 ID 去重；只有第一次傳送會觸發回應。

## Security

- 切勿提交私鑰。
- 使用環境變數來存放金鑰。
- 考慮 `allowlist` 用於生產環境的機器人。

## 限制 (MVP)

- 只限直接訊息（不支援群組聊天）。
- 不支援媒體附件。
- 僅支援 NIP-04（計畫支援 NIP-17 禮物包裝）。
