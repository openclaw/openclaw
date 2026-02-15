---
summary: "OpenClaw 狀態呈現條目如何產生、合併與顯示"
read_when:
  - 偵錯實例分頁
  - 調查重複或過期的實例列
  - 更改 Gateway WebSocket 連線或系統事件信標
title: "狀態呈現"
---

# 狀態呈現

OpenClaw 的「狀態呈現」是對以下內容的輕量級、盡力而為的檢視：

- **Gateway** 本身，以及
- **連接到 Gateway 的用戶端**（mac 應用程式、WebChat、CLI 等）

狀態呈現主要用於呈現 macOS 應用程式的「**實例**」分頁，並提供操作人員快速檢視。

## 狀態呈現欄位 (顯示內容)

狀態呈現條目是結構化物件，包含以下欄位：

- `instanceId` (選填，但強烈建議)：穩定的用戶端身份（通常為 `connect.client.instanceId`）
- `host`：人類易讀的主機名稱
- `ip`：盡力而為的 IP 位址
- `version`：用戶端版本字串
- `deviceFamily` / `modelIdentifier`：硬體提示
- `mode`：`ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`：「自上次使用者輸入以來的秒數」（如果已知）
- `reason`：`self`, `connect`, `node-connected`, `periodic`, ...
- `ts`：最後更新時間戳記（自 epoch 以來的毫秒數）

## 產生器 (狀態呈現的來源)

狀態呈現條目由多個來源產生並**合併**。

### 1) Gateway 自身條目

Gateway 在啟動時總是會建立一個「自身」條目，以便 UI 在任何用戶端連接之前就能顯示 Gateway 主機。

### 2) WebSocket 連線

每個 WS 用戶端都以 `connect` 請求開始。成功握手後，Gateway 會為該連線更新或插入一個狀態呈現條目。

#### 為何一次性 CLI 命令不顯示

CLI 通常會連接以執行簡短的一次性命令。為了避免濫發「實例」列表，`client.mode === "cli"` **不會**被轉換為狀態呈現條目。

### 3) `system-event` 信標

用戶端可以透過 `system-event` 方法發送更豐富的週期性信標。mac 應用程式使用此功能來報告主機名稱、IP 和 `lastInputSeconds`。

### 4) 節點連線 (角色: node)

當節點透過 Gateway WebSocket 以 `role: node` 連接時，Gateway 會為該節點更新或插入一個狀態呈現條目（與其他 WS 用戶端的流程相同）。

## 合併 + 去重複規則 (為何 `instanceId` 很重要)

狀態呈現條目儲存在單一的記憶體內部映射中：

- 條目以**狀態呈現鍵**作為鍵。
- 最佳鍵是穩定的 `instanceId`（來自 `connect.client.instanceId`），它在重新啟動後仍然存在。
- 鍵不區分大小寫。

如果用戶端在沒有穩定 `instanceId` 的情況下重新連接，它可能會顯示為**重複**列。

## 存留時間 (TTL) 與有限大小

狀態呈現是刻意短暫的：

- **存留時間 (TTL)**：超過 5 分鐘的條目將被修剪
- **最大條目數**：200（最舊的優先丟棄）

這使得列表保持最新並避免記憶體無限增長。

## 遠端/通道注意事項 (迴路 IP)

當用戶端透過 SSH 通道 / 本機連接埠轉發連接時，Gateway 可能會將遠端位址視為 `127.0.0.1`。為避免覆寫用戶端報告的正確 IP，本機迴路遠端位址將被忽略。

## 消費者

### macOS 實例分頁

macOS 應用程式會渲染 `system-presence` 的輸出，並根據上次更新的時間長度應用一個小的狀態指示器（啟用中/閒置/過期）。

## 偵錯提示

- 若要查看原始列表，請對 Gateway 呼叫 `system-presence`。
- 如果您看到重複項：
  - 確認用戶端在握手中發送穩定的 `client.instanceId`
  - 確認週期性信標使用相同的 `instanceId`
  - 檢查連線衍生條目是否缺少 `instanceId`（預期會出現重複項）
