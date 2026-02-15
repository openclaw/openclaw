---
summary: "OpenClaw presence 項目是如何產生、合併與顯示的"
read_when:
  - 除錯 Instances 分頁時
  - 調查重複或過期的實例資料列時
  - 修改 Gateway WS 連線或 system-event 信標 (beacon) 時
title: "Presence"
---

# Presence

OpenClaw 「presence」是一個輕量、盡力而為 (best‑effort) 的檢視，內容包含：

- **Gateway** 本身，以及
- **連接到 Gateway 的用戶端** (mac 應用程式、WebChat、CLI 等)

Presence 主要用於渲染 macOS 應用程式的 **Instances** 分頁，並為操作者提供快速的可視化資訊。

## Presence 欄位 (顯示內容)

Presence 項目是具有以下欄位的結構化物件：

- `instanceId` (選填，但強烈建議使用)：穩定的用戶端身分識別 (通常為 `connect.client.instanceId`)
- `host`：易於閱讀的主機名稱
- `ip`：盡力而為提供的 IP 位址
- `version`：用戶端版本字串
- `deviceFamily` / `modelIdentifier`：硬體提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node` ...
- `lastInputSeconds`：「自上次使用者輸入後的秒數」(若已知)
- `reason`：`self`、`connect`、`node-connected`、`periodic` ...
- `ts`：上次更新的時間戳記 (自 epoch 以來的毫秒數)

## 產生來源 (Presence 的來源)

Presence 項目由多個來源產生並進行**合併**。

### 1) Gateway 本身項目 (self entry)

Gateway 在啟動時總是會植入一個 「self」項目，以便在任何用戶端連線之前，UI 就能顯示 Gateway 主機。

### 2) WebSocket 連線

每個 WS 用戶端都以 `connect` 請求開始。握手成功後，Gateway 會為該連線 upsert（更新或插入）一筆 presence 項目。

#### 為什麼一次性 CLI 指令不會出現

CLI 經常為了執行簡短的一次性指令而連線。為了避免佔滿 Instances 列表，當 `client.mode === "cli"` 時**不會**被轉換為 presence 項目。

### 3) `system-event` 信標 (beacons)

用戶端可以透過 `system-event` 方法發送更豐富的定期信標 (beacon)。mac 應用程式使用此方法來回報主機名稱、IP 以及 `lastInputSeconds`。

### 4) 節點連線 (role: node)

當節點透過 Gateway WebSocket 以 `role: node` 連線時，Gateway 會為該節點 upsert 一筆 presence 項目 (流程與其他 WS 用戶端相同)。

## 合併與去重規則 (為什麼 `instanceId` 很重要)

Presence 項目儲存在單一的記憶體內 map 中：

- 項目以 **presence key** 作為鍵名。
- 最理想的鍵名是穩定的 `instanceId` (來自 `connect.client.instanceId`)，它在重啟後仍能保持不變。
- 鍵名不區分大小寫。

如果用戶端在沒有穩定 `instanceId` 的情況下重新連線，它可能會顯示為**重複**的資料列。

## TTL 與容量限制

Presence 被刻意設計為暫時性的：

- **TTL：** 超過 5 分鐘的項目會被清除。
- **最大項目數：** 200 (最舊的會先被捨棄)。

這能保持列表更新，並避免記憶體無限制增長。

## 遠端/通道注意事項 (loopback IP)

當用戶端透過 SSH 通道 / 本地連接埠轉發連線時，Gateway 可能會將遠端位址視為 `127.0.0.1`。為了避免覆蓋掉用戶端回報的正確 IP，會忽略 local loopback 遠端位址。

## 使用者

### macOS Instances 分頁

macOS 應用程式會渲染 `system-presence` 的輸出，並根據上次更新的時間套用一個小的狀態指示燈 (使用中 Active / 閒置 Idle / 已過期 Stale)。

## 除錯提示

- 若要查看原始列表，請對 Gateway 呼叫 `system-presence`。
- 如果看到重複項：
  - 確認用戶端在握手期間發送了穩定的 `client.instanceId`
  - 確認定期信標 (beacon) 使用相同的 `instanceId`
  - 檢查衍生自連線的項目是否缺少 `instanceId` (這種情況下出現重複是預料之中的)
