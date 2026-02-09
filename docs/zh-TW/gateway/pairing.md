---
summary: "適用於 iOS 與其他遠端節點的 Gateway 擁有節點配對（選項 B）"
read_when:
  - Implementing node pairing approvals without macOS UI
  - 新增用於核准遠端節點的 CLI 流程
  - 以節點管理擴充 Gateway 通訊協定
title: "Gateway 擁有的配對"
---

# Gateway 擁有的配對（選項 B）

In Gateway-owned pairing, the **Gateway** is the source of truth for which nodes
are allowed to join. 9. UI（macOS 應用程式、未來的客戶端）僅是前端，用來核准或拒絕待處理的請求。

**重要：** WS 節點在 `connect` 期間使用 **device pairing**（角色 `node`）。`node.pair.*` 是獨立的配對儲存區，且**不會**限制 WS 握手。只有明確呼叫 `node.pair.*` 的客戶端才會使用此流程。
`node.pair.*` is a separate pairing store and does **not** gate the WS handshake.
Only clients that explicitly call `node.pair.*` use this flow.

## 概念

- 12. **待處理請求**：節點請求加入；需要核准。
- **Paired node**: approved node with an issued auth token.
- 14. **傳輸層**：Gateway 的 WS 端點會轉送請求，但不決定成員資格。 (Legacy TCP bridge support is deprecated/removed.)

## 配對運作方式

1. A node connects to the Gateway WS and requests pairing.
2. Gateway 儲存一筆 **待處理請求** 並發送 `node.pair.requested`。
3. 你核准或拒絕該請求（透過 CLI 或 UI）。
4. On approval, the Gateway issues a **new token** (tokens are rotated on re‑pair).
5. The node reconnects using the token and is now “paired”.

待處理請求會在 **5 分鐘** 後自動到期。

## CLI 工作流程（適合無介面環境）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 會顯示已配對／已連線的節點及其能力。

## API 介面（Gateway 通訊協定）

事件：

- `node.pair.requested` — 建立新的待處理請求時發送。
- `node.pair.resolved` — 請求被核准／拒絕／到期時發送。

方法：

- `node.pair.request` — 建立或重用待處理請求。
- `node.pair.list` — 列出待處理＋已配對的節點。
- `node.pair.approve` — 核准待處理請求（發行權杖）。
- `node.pair.reject` — 拒絕待處理請求。
- `node.pair.verify` — 驗證 `{ nodeId, token }`。

注意事項：

- `node.pair.request` 對每個節點具有冪等性：重複呼叫會回傳相同的待處理請求。
- Approval **always** generates a fresh token; no token is ever returned from
  `node.pair.request`.
- 請求可包含 `silent: true`，作為自動核准流程的提示。

## 自動核准（macOS 應用程式）

當符合以下條件時，macOS 應用程式可選擇嘗試 **靜默核准**：

- 請求被標記為 `silent`，且
- the app can verify an SSH connection to the gateway host using the same user.

21. 若靜默核准失敗，會回退到一般的「核准/拒絕」提示。

## Storage (local, private)

23. 配對狀態儲存在 Gateway 狀態目錄下（預設為 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

若你覆寫 `OPENCLAW_STATE_DIR`，`nodes/` 資料夾也會隨之移動。

安全性注意事項：

- Tokens are secrets; treat `paired.json` as sensitive.
- Rotating a token requires re-approval (or deleting the node entry).

## Transport behavior

- The transport is **stateless**; it does not store membership.
- 若 Gateway 離線或停用配對，節點將無法配對。
- 若 Gateway 處於遠端模式，配對仍會針對遠端 Gateway 的儲存區進行。
