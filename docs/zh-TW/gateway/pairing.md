---
summary: Gateway-owned node pairing (Option B) for iOS and other remote nodes
read_when:
  - Implementing node pairing approvals without macOS UI
  - Adding CLI flows for approving remote nodes
  - Extending gateway protocol with node management
title: Gateway-Owned Pairing
---

# Gateway 擁有的配對 (選項 B)

在閘道擁有的配對中，**閘道**是決定哪些節點被允許加入的真實來源。用戶介面（macOS 應用程式、未來的用戶端）只是前端，負責批准或拒絕待處理的請求。

**重要：** WS 節點在 `connect` 期間使用 **設備配對** (角色 `node`)。`node.pair.*` 是一個獨立的配對儲存，並不會限制 WS 握手。只有明確呼叫 `node.pair.*` 的用戶端才會使用此流程。

## 概念

- **待處理請求**：一個節點請求加入；需要批准。
- **配對節點**：已批准的節點，並已發出授權 token。
- **傳輸**：Gateway WS 端點轉發請求，但不決定成員資格。（舊版 TCP 橋接支援已被棄用/移除。）

## 如何配對運作

1. 一個節點連接到 Gateway WS 並請求配對。
2. Gateway 儲存一個 **待處理請求** 並發出 `node.pair.requested`。
3. 你可以批准或拒絕該請求（使用 CLI 或 UI）。
4. 在批准後，Gateway 發出一個 **新 token**（在重新配對時會輪換 token）。
5. 節點使用該 token 重新連接，並且現在已經“配對”。

待處理的請求會在 **5 分鐘** 後自動過期。

## CLI 工作流程（適合無頭環境）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 顯示配對/連接的節點及其功能。

## API 表面 (閘道協議)

Events:

- `node.pair.requested` — 當一個新的待處理請求被創建時發出。
- `node.pair.resolved` — 當請求被批准/拒絕/過期時發出。

[[BLOCK_1]]  
方法：  
[[BLOCK_1]]

- `node.pair.request` — 創建或重用一個待處理的請求。
- `node.pair.list` — 列出待處理 + 配對的節點。
- `node.pair.approve` — 批准一個待處理的請求（發行 token）。
- `node.pair.reject` — 拒絕一個待處理的請求。
- `node.pair.verify` — 驗證 `{ nodeId, token }`。

[[BLOCK_1]]

- `node.pair.request` 在每個節點上是冪等的：重複調用會返回相同的待處理請求。
- 批准 **總是** 生成一個新的 token；不會從 `node.pair.request` 返回任何 token。
- 請求可以包含 `silent: true` 作為自動批准流程的提示。

## 自動批准 (macOS 應用程式)

macOS 應用程式可以選擇在以下情況下嘗試 **靜默批准**：

- 請求標記為 `silent`，並且
- 應用程式可以使用相同的使用者驗證與閘道主機的 SSH 連接。

如果靜默批准失敗，則會回退到正常的「批准/拒絕」提示。

## 儲存（本地，私有）

配對狀態儲存在閘道狀態目錄下（預設 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

如果你覆蓋 `OPENCLAW_STATE_DIR`，則 `nodes/` 資料夾也會隨之移動。

安全注意事項：

- Tokens 是秘密；請將 `paired.json` 視為敏感資訊。
- 旋轉 token 需要重新批准（或刪除節點條目）。

## 運輸行為

- 傳輸是 **無狀態** 的；它不儲存成員資格。
- 如果 Gateway 離線或配對被禁用，節點無法進行配對。
- 如果 Gateway 處於遠端模式，配對仍然會針對遠端 Gateway 的儲存進行。
