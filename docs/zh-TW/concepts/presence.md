---
summary: "OpenClaw presence 項目如何產生、合併與顯示"
read_when:
  - 除錯 Instances 分頁
  - 調查重複或過時的 instance 列
  - 變更 Gateway WS 連線或系統事件 beacon
title: "Presence"
---

# Presence

OpenClaw 的「presence」是一種輕量、盡力而為的檢視方式，用來呈現：

- **Gateway** 本身，以及
- **連線到 Gateway 的用戶端**（mac app、WebChat、CLI 等）

Presence 主要用於繪製 macOS app 的 **Instances** 分頁，並提供操作人員快速的可見性。

## Presence 欄位（顯示內容）

Presence 項目是具有以下欄位的結構化物件，例如：

- `instanceId`（選用但強烈建議）：穩定的用戶端身分（通常是 `connect.client.instanceId`）
- `host`：人類可讀的主機名稱
- `ip`：盡力而為的 IP 位址
- `version`：用戶端版本字串
- `deviceFamily` / `modelIdentifier`：硬體提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`、…
- `lastInputSeconds`：「距離上次使用者輸入的秒數」（若可得）
- `reason`：`self`、`connect`、`node-connected`、`periodic`、…
- `ts`：最後更新時間戳（自 epoch 起算的毫秒）

## Producers（presence 的來源）

Presence 項目由多個來源產生並**合併**。

### 1. Gateway 自身項目

Gateway 在啟動時一定會先建立一筆「self」項目，讓 UI 即使在尚未有任何用戶端連線前，也能顯示 Gateway 主機。

### 2. WebSocket 連線

每個 WS 用戶端都以一個 `connect` 請求開始。 在成功完成握手後，
Gateway 會為該連線 upsert 一筆 presence 項目。

#### 為什麼一次性的 CLI 指令不會顯示

CLI 常用於短暫的一次性指令連線。 為避免洗版 Instances 清單，`client.mode === "cli"` **不會**被轉換為 presence 項目。

### 3. `system-event` beacon

用戶端可以透過 `system-event` 方法傳送更豐富的定期 beacon。 mac
app 使用此方式回報主機名稱、IP，以及 `lastInputSeconds`。

### 4. Node 連線（角色：node）

當 node 以 `role: node` 透過 Gateway WebSocket 連線時，Gateway 會為該 node upsert 一筆 presence 項目（流程與其他 WS 用戶端相同）。

## 合併與去重規則（為什麼 `instanceId` 很重要）

Presence 項目會儲存在單一的記憶體內 map 中：

- 項目以 **presence key** 作為索引。
- 最佳的 key 是一個穩定的 `instanceId`（來自 `connect.client.instanceId`），可跨重新啟動維持不變。
- 鍵值不分大小寫。

如果用戶端在重新連線時沒有提供穩定的 `instanceId`，可能會顯示為**重複**的列。

## TTL 與數量上限

Presence 是刻意設計為短暫的：

- **TTL：** 超過 5 分鐘的項目會被清除
- **最大項目數：** 200（最舊的會先被移除）

這能保持清單新鮮，並避免記憶體無限制成長。

## Remote／通道注意事項（loopback IP）

當用戶端透過 SSH 通道／本地連接埠轉送連線時，Gateway 可能會
將遠端位址視為 `127.0.0.1`。 為避免覆寫良好的用戶端回報 IP，會忽略迴圈位址的遠端位址。

## Consumers

### macOS Instances 分頁

macOS app 會呈現 `system-presence` 的輸出，並根據最後一次更新的時間
套用小型狀態指示器（Active/Idle/Stale）。

## 除錯提示

- 若要查看原始清單，可對 Gateway 呼叫 `system-presence`。
- 如果看到重複項目：
  - 確認用戶端在 handshake 中送出穩定的 `client.instanceId`
  - 確認週期性 beacon 使用相同的 `instanceId`
  - 檢查是否有由連線衍生的項目缺少 `instanceId`（此情況下出現重複是預期的）
