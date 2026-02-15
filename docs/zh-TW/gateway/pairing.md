---
summary: "由 Gateway 主導的節點配對 (選項 B)，適用於 iOS 及其他遠端節點"
read_when:
  - 在沒有 macOS UI 的情況下實作節點配對核准
  - 增加用於核准遠端節點的 CLI 流程
  - 使用節點管理擴充 Gateway 協定
title: "由 Gateway 主導的配對"
---

# 由 Gateway 主導的配對 (選項 B)

在由 Gateway 主導的配對中，**Gateway** 是判斷哪些節點允許加入的單一事實來源。UI（macOS 應用程式、未來的用戶端）僅是負責核准或拒絕待處理請求的前端。

**重要事項：** WS 節點在 `connect` 期間使用**裝置配對**（角色為 `node`）。`node.pair.*` 是獨立的配對儲存，**不會**攔截 WS 握手過程。只有明確呼叫 `node.pair.*` 的用戶端會使用此流程。

## 概念

- **待處理請求 (Pending request)**：節點請求加入；需要核准。
- **已配對節點 (Paired node)**：已核准並核發驗證權杖的節點。
- **傳輸協定 (Transport)**：Gateway WS 端點負責轉發請求，但不決定成員資格。（舊有的 TCP bridge 支援已棄用/移除。）

## 配對運作方式

1. 節點連接到 Gateway WS 並請求配對。
2. Gateway 會儲存一個**待處理請求**並發送 `node.pair.requested`。
3. 您可以核准或拒絕該請求（透過 CLI 或 UI）。
4. 核准後，Gateway 會核發**新權杖**（權杖會在重新配對時更換）。
5. 節點使用該權杖重新連接，現在即為「已配對」狀態。

待處理請求將在 **5 分鐘**後自動過期。

## CLI 流程（適合無介面環境）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 顯示已配對/已連接的節點及其功能。

## API 介面 (Gateway 協定)

事件：

- `node.pair.requested` — 建立新的待處理請求時發送。
- `node.pair.resolved` — 當請求被核准、拒絕或過期時發送。

方法：

- `node.pair.request` — 建立或重複使用待處理請求。
- `node.pair.list` — 列出待處理與已配對的節點。
- `node.pair.approve` — 核准待處理請求（核發權杖）。
- `node.pair.reject` — 拒絕待處理請求。
- `node.pair.verify` — 驗證 `{ nodeId, token }`。

注意事項：

- `node.pair.request` 對每個節點具備冪等性 (idempotent)：重複呼叫會回傳相同的待處理請求。
- 核准**一律**會產生新的權杖；`node.pair.request` 絕不會回傳權杖。
- 請求可能包含 `silent: true`，作為自動核准流程的提示。

## 自動核准 (macOS 應用程式)

在以下情況，macOS 應用程式可以選擇嘗試**背景自動核准 (silent approval)**：

- 請求標記為 `silent`，且
- 應用程式可以透過同一個使用者驗證與 Gateway 主機的 SSH 連線。

如果自動核准失敗，它會退回到正常的「核准/拒絕」提示。

## 儲存位置（本地、私用）

配對狀態儲存在 Gateway 狀態目錄下（預設為 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

如果您覆蓋了 `OPENCLAW_STATE_DIR`，`nodes/` 資料夾也會隨之移動。

安全注意事項：

- 權杖為金鑰；請將 `paired.json` 視為敏感資料。
- 更換權杖需要重新核准（或刪除該節點項目）。

## 傳輸協定行為

- 傳輸協定是**無狀態的 (stateless)**；它不儲存成員資格。
- 如果 Gateway 離線或配對功能已停用，節點將無法配對。
- 如果 Gateway 處於遠端模式，配對仍會針對遠端 Gateway 的儲存進行。
