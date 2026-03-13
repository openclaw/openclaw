---
summary: "How OpenClaw presence entries are produced, merged, and displayed"
read_when:
  - Debugging the Instances tab
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
title: Presence
---

# Presence

OpenClaw “presence” 是一個輕量級的最佳努力視圖，包含：

- **Gateway** 本身，以及
- **連接到 Gateway 的用戶端**（mac 應用程式、WebChat、CLI 等）

Presence 主要用於渲染 macOS 應用程式的 **Instances** 標籤，並提供快速的操作員可見性。

## Presence fields (顯示內容)

Presence entries 是結構化的物件，包含以下欄位：

- `instanceId`（可選但強烈建議）：穩定的用戶端身份（通常是 `connect.client.instanceId`）
- `host`：人性化的主機名稱
- `ip`：最佳努力的 IP 位址
- `version`：用戶端版本字串
- `deviceFamily` / `modelIdentifier`：硬體提示
- `mode`：`ui`、`webchat`、`cli`、`backend`、`probe`、`test`、`node`、...
- `lastInputSeconds`：“自上次用戶輸入以來的秒數”（如果已知）
- `reason`：`self`、`connect`、`node-connected`、`periodic`、...
- `ts`：最後更新時間戳（自紀元以來的毫秒）

## Producers (來源)

Presence entries 是由多個來源產生並 **合併** 的。

### 1) 閘道自我輸入

Gateway 在啟動時總是會播種一個「自我」條目，以便在任何用戶端連接之前，使用者介面能顯示網關主機。

### 2) WebSocket 連接

每個 WS 用戶端都以 `connect` 請求開始。在成功的握手後，Gateway 會為該連接更新或插入一個存在條目。

#### 為什麼一次性 CLI 命令不會顯示出來

CLI 通常用於短暫的一次性命令。為了避免在 Instances 列表中產生過多的條目，`client.mode === "cli"` **不** 會轉換為存在條目。

### 3) `system-event` 信標

用戶端可以透過 `system-event` 方法發送更豐富的定期信標。mac 應用程式使用這個方法來報告主機名稱、IP 以及 `lastInputSeconds`。

### 4) 節點連接 (角色：節點)

當一個節點透過 Gateway WebSocket 連接到 `role: node` 時，Gateway 會為該節點更新或插入一個存在條目（與其他 WS 用戶端相同的流程）。

## 合併 + 去重規則（為什麼 `instanceId` 重要）

Presence entries 是儲存在單一的記憶體映射中：

- 條目是由 **存在鍵** 來索引的。
- 最佳鍵是一個穩定的 `instanceId`（來自 `connect.client.instanceId`），能夠在重啟後存活。
- 鍵是大小寫不敏感的。

如果用戶端在沒有穩定的 `instanceId` 情況下重新連接，可能會顯示為 **重複** 的行。

## TTL 和大小限制

Presence 是故意短暫的：

- **TTL:** 超過 5 分鐘的條目會被修剪
- **最大條目數:** 200（最舊的條目優先被刪除）

這樣可以保持列表的新鮮度，並避免無限制的記憶體增長。

## Remote/tunnel caveat (loopback IPs)

當用戶端透過 SSH 隧道 / 本地端口轉發連接時，網關可能會將遠端地址視為 `127.0.0.1`。為了避免覆蓋良好的用戶端報告的 IP，迴圈回路的遠端地址會被忽略。

## Consumers

### macOS 實例標籤

macOS 應用程式渲染 `system-presence` 的輸出，並根據最後更新的時間為其應用一個小狀態指示器（活動/閒置/過期）。

## Debugging tips

- 要查看原始列表，請對 Gateway 呼叫 `system-presence`。
- 如果您看到重複項：
  - 確認用戶端在握手中發送穩定的 `client.instanceId`
  - 確認定期信標使用相同的 `instanceId`
  - 檢查是否缺少連接衍生的條目 `instanceId`（重複項是預期的）
