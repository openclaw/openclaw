---
summary: "Gateway 擁有的節點配對（選項 B），適用於 iOS 及其他遠端節點"
read_when:
  - 在沒有 macOS UI 的情況下實作節點配對審批
  - 新增用於核准遠端節點的 CLI 流程
  - 擴展 Gateway 協定以支援節點管理
title: "Gateway 擁有的配對"
---

# Gateway 擁有的配對（選項 B）

在 Gateway 擁有的配對中，**Gateway**是判斷哪些節點被允許加入的唯一資訊來源。使用者介面（macOS 應用程式、未來用戶端）只是核准或拒絕待處理請求的前端。

**重要：**WS 節點在 `connect` 期間使用**裝置配對**（角色 `node`）。`node.pair.*` 是獨立的配對儲存，並**不會**限制 WS 握手。只有明確呼叫 `node.pair.*` 的用戶端才使用此流程。

## 概念

- **待處理請求**：節點請求加入；需要核准。
- **已配對節點**：已核准的節點，並已發行憑證權杖。
- **傳輸協定**：Gateway WS 端點轉發請求但不會決定成員資格。（舊版 TCP 橋接支援已棄用/移除。）

## 配對運作方式

1. 節點連接到 Gateway WS 並請求配對。
2. Gateway 儲存一個**待處理請求**並發出 `node.pair.requested`。
3. 您核准或拒絕該請求（CLI 或使用者介面）。
4. 核准後，Gateway 發行一個**新權杖**（重新配對時權杖會輪換）。
5. 節點使用該權杖重新連接，現在處於「已配對」狀態。

待處理請求在**五分鐘**後自動過期。

## CLI 工作流程（無頭模式友善）

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` 顯示已配對/已連接的節點及其功能。

## API 介面（Gateway 協定）

事件：

- `node.pair.requested` — 當建立新的待處理請求時發出。
- `node.pair.resolved` — 當請求被核准/拒絕/過期時發出。

方法：

- `node.pair.request` — 建立或重複使用待處理請求。
- `node.pair.list` — 列出待處理 + 已配對的節點。
- `node.pair.approve` — 核准待處理請求（發行權杖）。
- `node.pair.reject` — 拒絕待處理請求。
- `node.pair.verify` — 驗證 `{ nodeId, token }`。

注意事項：

- `node.pair.request` 對每個節點都是冪等的：重複呼叫會回傳相同的待處理請求。
- 核准**總是**會產生一個新權杖；`node.pair.request` 永遠不會回傳權杖。
- 請求可能包含 `silent: true` 作為自動核准流程的提示。

## 自動核准（macOS 應用程式）

macOS 應用程式可以選擇在以下情況嘗試**靜默核准**：

- 請求被標記為 `silent`，以及
- 應用程式可以使用相同的使用者驗證到 Gateway 主機的 SSH 連線。

如果靜默核准失敗，則會回退到正常的「核准/拒絕」提示。

## 儲存（本地，私人）

配對狀態儲存在 Gateway 狀態目錄下（預設 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

如果您覆寫 `OPENCLAW_STATE_DIR`，則 `nodes/` 資料夾會隨之移動。

安全注意事項：

- 權杖是機密資訊；將 `paired.json` 視為敏感檔案。
- 輪換權杖需要重新核准（或刪除節點條目）。

## 傳輸協定行為

- 傳輸協定是**無狀態的**；它不儲存成員資格。
- 如果 Gateway 離線或配對被停用，節點無法配對。
- 如果 Gateway 處於遠端模式，配對仍然針對遠端 Gateway 的儲存進行。
