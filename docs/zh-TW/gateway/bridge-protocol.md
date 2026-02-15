---
summary: "Bridge 通訊協定（舊版節點）：TCP JSONL、配對、限縮範圍的 RPC"
read_when:
  - 建置或偵錯節點用戶端（iOS/Android/macOS 節點模式）
  - 調查配對或 Bridge 認證失敗
  - 稽核 Gateway 暴露的節點介面
title: "Bridge 通訊協定"
---

# Bridge 通訊協定（舊版節點傳輸）

Bridge 通訊協定是一種 **舊版** 的節點傳輸方式（TCP JSONL）。新的節點用戶端應改用統一的 Gateway WebSocket 通訊協定。

如果您正在開發操作端或節點用戶端，請使用 [Gateway 通訊協定](/gateway/protocol)。

**注意：** 目前的 OpenClaw 版本已不再內建 TCP bridge 監聽器；本文件僅保留作為歷史參考。舊版的 `bridge.*` 設定鍵名已不再屬於設定結構（schema）的一部分。

## 為何兩者並存

- **安全邊界**：Bridge 僅暴露一個小的允許清單，而非整個 Gateway API 介面。
- **配對與節點身份**：節點准入由 Gateway 管理，並與每個節點的權杖（token）綁定。
- **裝置探索體驗**：節點可透過區域網路（LAN）上的 Bonjour 發現 Gateway，或直接透過 tailnet 連線。
- **Local loopback WS**：除非透過 SSH 通道，否則完整的 WS 控制平面僅保留在本地。

## 傳輸

- TCP，每行一個 JSON 物件（JSONL）。
- 選用 TLS（當 `bridge.tls.enabled` 為 true 時）。
- 舊版預設監聽埠為 `18790`（目前的版本不會啟動 TCP bridge）。

啟用 TLS 時，裝置探索的 TXT 紀錄會包含 `bridgeTls=1` 以及 `bridgeTlsSha256`，以便節點進行憑證固定（pinning）。

## 握手與配對

1. 用戶端發送 `hello` 以及節點元數據與權杖（若已配對）。
2. 若未配對，Gateway 會回覆 `error`（`NOT_PAIRED`/`UNAUTHORIZED`）。
3. 用戶端發送 `pair-request`。
4. Gateway 等待核准，隨後發送 `pair-ok` 與 `hello-ok`。

`hello-ok` 會回傳 `serverName`，並可能包含 `canvasHostUrl`。

## 框架 (Frames)

用戶端 → Gateway：

- `req` / `res`：限縮範圍的 Gateway RPC（chat, sessions, config, health, voicewake, skills.bins）
- `event`：節點訊號（語音轉錄、智慧代理請求、聊天訂閱、執行生命週期）

Gateway → 用戶端：

- `invoke` / `invoke-res`：節點指令（`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`）
- `event`：已訂閱工作階段的聊天更新
- `ping` / `pong`：存活檢查（keepalive）

舊版的允許清單強制執行邏輯原位於 `src/gateway/server-bridge.ts`（已移除）。

## 執行生命週期事件

節點可以發送 `exec.finished` 或 `exec.denied` 事件來反映 system.run 的活動。這些事件會映射到 Gateway 中的系統事件。（舊版節點可能仍會發送 `exec.started`。）

酬載欄位（除非特別註明，否則均為選填）：

- `sessionKey`（必填）：接收系統事件的智慧代理工作階段。
- `runId`：用於分組的唯一執行 ID。
- `command`：原始或格式化後的指令字串。
- `exitCode`, `timedOut`, `success`, `output`：完成詳情（僅限 finished）。
- `reason`：拒絕原因（僅限 denied）。

## Tailnet 使用方式

- 將 Bridge 綁定至 tailnet IP：在 `~/.openclaw/openclaw.json` 中設定 `bridge.bind: "tailnet"`。
- 用戶端透過 MagicDNS 名稱或 tailnet IP 連線。
- Bonjour 無法跨網路運作；需要時請使用手動主機/連接埠或廣域 DNS-SD。

## 版本控制

Bridge 目前為隱含的 **v1 版本**（無最小/最大版本協商）。預期具備回溯相容性；在進行任何重大變更（breaking changes）前，請先增加 Bridge 通訊協定版本欄位。
