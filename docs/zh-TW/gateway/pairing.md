---
summary: "適用於 iOS 與其他遠端節點的 Gateway 擁有節點配對（選項 B）"
read_when:
  - 在沒有 macOS UI 的情況下實作節點配對核准
  - 新增用於核准遠端節點的 CLI 流程
  - 以節點管理擴充 Gateway 通訊協定
title: "Gateway 擁有的配對"
x-i18n:
  source_path: gateway/pairing.md
  source_hash: 1f5154292a75ea2c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:08Z
---

# Gateway 擁有的配對（選項 B）

在 Gateway 擁有的配對中，**Gateway** 是決定哪些節點允許加入的唯一事實來源。UI（macOS 應用程式、未來的客戶端）僅作為前端，用於核准或拒絕待處理的請求。

**重要：** WS 節點在 `connect` 期間使用 **device pairing**（角色 `node`）。`node.pair.*` 是獨立的配對儲存區，且**不會**限制 WS 握手。只有明確呼叫 `node.pair.*` 的客戶端才會使用此流程。

## 概念

- **待處理請求**：節點請求加入；需要核准。
- **已配對節點**：已核准且取得已發行驗證權杖的節點。
- **傳輸**：Gateway WS 端點負責轉送請求，但不決定成員資格。（舊版 TCP 橋接支援已淘汰／移除。）

## 配對運作方式

1. 節點連線至 Gateway WS 並請求配對。
2. Gateway 儲存一筆 **待處理請求** 並發送 `node.pair.requested`。
3. 你核准或拒絕該請求（透過 CLI 或 UI）。
4. 核准後，Gateway 會發行一個 **新的權杖**（重新配對時會輪替權杖）。
5. 節點使用該權杖重新連線，並成為「已配對」。

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
- 核准 **一定** 會產生全新的權杖；`node.pair.request` **不會** 回傳任何權杖。
- 請求可包含 `silent: true`，作為自動核准流程的提示。

## 自動核准（macOS 應用程式）

當符合以下條件時，macOS 應用程式可選擇嘗試 **靜默核准**：

- 請求被標記為 `silent`，且
- 應用程式能以相同使用者驗證至閘道器主機的 SSH 連線。

若靜默核准失敗，則回退至一般的「核准／拒絕」提示。

## 儲存（本機、私有）

配對狀態儲存在 Gateway 狀態目錄下（預設為 `~/.openclaw`）：

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

若你覆寫 `OPENCLAW_STATE_DIR`，`nodes/` 資料夾也會隨之移動。

安全性注意事項：

- 權杖屬於機密；請將 `paired.json` 視為敏感資料。
- 輪替權杖需要重新核准（或刪除節點項目）。

## 傳輸行為

- 傳輸層為 **無狀態**；不儲存成員資格。
- 若 Gateway 離線或停用配對，節點將無法配對。
- 若 Gateway 處於遠端模式，配對仍會針對遠端 Gateway 的儲存區進行。
