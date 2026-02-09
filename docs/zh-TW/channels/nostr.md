---
summary: "透過 NIP-04 加密訊息的 Nostr 私訊頻道"
read_when:
  - 當你希望 OpenClaw 透過 Nostr 接收私訊
  - 32. 你正在設定去中心化的訊息傳遞
title: "Nostr"
---

# Nostr

33. **狀態：** 選用外掛（預設停用）。

34. Nostr 是一種用於社交網路的去中心化通訊協定。 35. 此頻道可讓 OpenClaw 透過 NIP-04 接收並回應加密的私訊（DM）。

## 安裝（依需求）

### 入門引導（建議）

- 入門引導精靈（`openclaw onboard`）與 `openclaw channels add` 會列出選用的頻道外掛。
- 36. 選擇 Nostr 會提示你按需安裝該外掛。

安裝預設值：

- **Dev 頻道 + 可用 git checkout：** 使用本機外掛路徑。
- **Stable/Beta：** 從 npm 下載。

37. 你隨時都可以在提示中覆寫此選擇。

### 手動安裝

```bash
openclaw plugins install @openclaw/nostr
```

使用本機 checkout（dev 工作流程）：

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

38. 安裝或啟用外掛後，請重新啟動閘道。

## 快速開始

1. 產生 Nostr 金鑰組（如有需要）：

```bash
# Using nak
nak key generate
```

2. 加入設定檔：

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. 39. 匯出金鑰：

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. 重新啟動 Gateway 閘道器。

## 設定參考

| Key          | Type                                                         | Default                                     | Description                       |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------- |
| `privateKey` | string                                                       | required                                    | 私鑰（`nsec` 或十六進位格式）                |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | 中繼站 URL（WebSocket）                |
| `dmPolicy`   | string                                                       | `pairing`                                   | 40. 私訊存取政策 |
| `allowFrom`  | string[] | `[]`                                        | 允許的寄件者公鑰                          |
| `enabled`    | boolean                                                      | `true`                                      | 啟用／停用頻道                           |
| `name`       | string                                                       | -                                           | 顯示名稱                              |
| `profile`    | object                                                       | -                                           | NIP-01 個人資料中繼資料                   |

## Profile metadata

Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.

範例：

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

注意事項：

- 個人資料 URL 必須使用 `https://`。
- Importing from relays merges fields and preserves local overrides.

## 存取控制

### DM policies

- **pairing**（預設）：未知的寄件者會收到配對碼。
- **allowlist**：只有 `allowFrom` 中的公鑰可以私訊。
- **open**：公開的入站私訊（需要 `allowFrom: ["*"]`）。
- **disabled**：忽略入站私訊。

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

支援的格式：

- **私鑰：** `nsec...` 或 64 字元十六進位
- **公鑰（`allowFrom`）：** `npub...` 或十六進位

## Relays

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

建議：

- Use 2-3 relays for redundancy.
- Avoid too many relays (latency, duplication).
- Paid relays can improve reliability.
- Local relays are fine for testing (`ws://localhost:7777`).

## 協定支援

| NIP    | Status | Description                                 |
| ------ | ------ | ------------------------------------------- |
| NIP-01 | 已支援    | 基本事件格式 + 個人資料中繼資料                           |
| NIP-04 | 已支援    | Encrypted DMs (`kind:4`) |
| NIP-17 | 規劃中    | Gift-wrapped DMs                            |
| NIP-44 | 規劃中    | 版本化加密                                       |

## 測試

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

### 手動測試

1. Note the bot pubkey (npub) from logs.
2. 開啟一個 Nostr 用戶端（Damus、Amethyst 等）。
3. DM the bot pubkey.
4. Verify the response.

## Troubleshooting

### 未接收訊息

- 確認私鑰有效。
- 確保中繼站 URL 可連線且使用 `wss://`（本機則使用 `ws://`）。
- 確認 `enabled` 不是 `false`。
- Check Gateway logs for relay connection errors.

### 未送出回應

- Check relay accepts writes.
- Verify outbound connectivity.
- Watch for relay rate limits.

### 重複回應

- Expected when using multiple relays.
- 訊息會依事件 ID 去重；只有第一個送達會觸發回應。

## 安全性

- 切勿提交私鑰。
- Use environment variables for keys.
- Consider `allowlist` for production bots.

## 限制（MVP）

- Direct messages only (no group chats).
- 不支援媒體附件。
- 僅支援 NIP-04（規劃支援 NIP-17 禮物封裝）。
