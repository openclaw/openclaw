---
summary: "How OpenClaw presence entries are produced, merged, and displayed"
read_when:
  - Debugging the Instances tab
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
title: Presence
---

# Presence

OpenClaw 的 “presence” 是一種輕量且盡力而為的狀態視圖，包含：

- **Gateway** 本身，以及
- 連接到 Gateway 的 **用戶端**（mac app、WebChat、CLI 等）

Presence 主要用於呈現 macOS app 的 **Instances** 分頁，並提供操作人員快速的可視化資訊。

## Presence 欄位（顯示內容）

Presence 條目是結構化物件，包含以下欄位：

- `instanceId`（可選但強烈建議）：穩定的用戶端身份（通常是 `connect.client.instanceId`）
- `host`：易於辨識的主機名稱
- `ip`：盡力而為的 IP 位址
- `version`：用戶端版本字串
- `deviceFamily` / `modelIdentifier`：硬體提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`、...
- `lastInputSeconds`：距離上次使用者輸入的秒數（若已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic`、...
- `ts`：最後更新時間戳（自 epoch 起的毫秒數）

## 來源（presence 的資料來源）

Presence 條目由多個來源產生並**合併**。

### 1) Gateway 自身條目

Gateway 在啟動時會自動產生一個「自身」條目，讓 UI 即使在尚未有任何用戶端連線前，也能顯示 gateway 主機。

### 2) WebSocket 連線

每個 WS 用戶端都會以 `connect` 請求開始。握手成功後，Gateway 會為該連線新增或更新一個 presence 條目。

#### 為什麼一次性 CLI 指令不會顯示

CLI 通常是為了短暫的一次性指令而連線。為避免 Instances 清單被淹沒，`client.mode === "cli"` 不會被轉換成 presence 條目。

### 3) `system-event` 信標

用戶端可以透過 `system-event` 方法傳送更豐富的週期性信標。mac 應用程式使用此方法來回報主機名稱、IP 以及 `lastInputSeconds`。

### 4) 節點連線（角色：節點）

當節點透過 Gateway WebSocket 使用 `role: node` 連線時，Gateway 會為該節點新增或更新一筆 presence 紀錄（流程與其他 WS 用戶端相同）。

## 合併與去重規則（為何 `instanceId` 很重要）

Presence 紀錄會存放在單一的記憶體映射表中：

- 紀錄以 **presence key** 作為鍵值。
- 最佳的 key 是一個穩定的 `instanceId`（來自 `connect.client.instanceId`），能夠在重啟後持續存在。
- key 不區分大小寫。

如果用戶端在沒有穩定 `instanceId` 的情況下重新連線，可能會出現 **重複** 紀錄。

## TTL 與限制大小

Presence 是刻意設計為短暫存在：

- **TTL：** 超過 5 分鐘的紀錄會被清除
- **最大紀錄數：** 200 筆（最舊的會先被刪除）

這樣可以保持列表的新鮮度，並避免記憶體無限制成長。

## 遠端／隧道注意事項（迴圈位址）

當用戶端透過 SSH 隧道或本地端口轉發連線時，Gateway 可能會看到遠端位址為 `127.0.0.1`。為避免覆寫用戶端回報的有效 IP，迴圈位址的遠端位址會被忽略。

## 消費者

### macOS Instances 分頁

macOS 應用程式會呈現 `system-presence` 的輸出，並根據最後更新時間顯示一個小的狀態指示器（活動中/閒置/過期）。

## 除錯技巧

- 若要查看原始清單，請對 Gateway 呼叫 `system-presence`。
- 如果看到重複專案：
  - 確認用戶端在握手時傳送穩定的 `client.instanceId`
  - 確認週期性信標使用相同的 `instanceId`
  - 檢查連線衍生的條目是否缺少 `instanceId`（重複專案是預期的）
