---
summary: "Bridge 協定（舊版節點）：TCP JSONL、配對、範圍化 RPC"
read_when:
  - 建置或偵錯節點用戶端 (iOS/Android/macOS 節點模式)
  - 調查配對或 Bridge 認證失敗
  - 稽核 Gateway 暴露的節點介面
title: "Bridge 協定"
---

# Bridge 協定（舊版節點傳輸）

Bridge 協定是**舊版**節點傳輸 (TCP JSONL)。新的節點用戶端應改用統一的 Gateway WebSocket 協定。

如果您正在建置操作員或節點用戶端，請使用 [Gateway 協定](/gateway/protocol)。

**注意：** 目前的 OpenClaw 版本不再包含 TCP Bridge 監聽器；本文件僅供歷史參考。
舊版 `bridge.*` 設定 鍵不再是 設定 綱要的一部分。

## 為何我們有兩種方式

- **安全邊界**：Bridge 暴露一個小的允許列表，而不是完整的 Gateway API 介面。
- **配對 + 節點身份**：節點准入由 Gateway 擁有，並綁定到每個節點的權杖。
- **裝置探索 UX**：節點可以透過區域網路上的 Bonjour 裝置探索 Gateway，或直接透過 tailnet 連接。
- **Loopback WS**：完整的 WS 控制平面保持本機，除非透過 SSH 通道傳輸。

## 傳輸

- TCP，每行一個 JSON 物件 (JSONL)。
- 可選 TLS (當 `bridge.tls.enabled` 為 true 時)。
- 舊版 預設 監聽埠為 `18790` (目前版本不啟動 TCP Bridge)。

當 TLS 啟用時，裝置探索 TXT 記錄包含 `bridgeTls=1` 加上 `bridgeTlsSha256`，以便節點可以釘選憑證。

## 握手 + 配對

1. 用戶端發送帶有節點元資料 + 權杖的 `hello` (如果已配對)。
2. 如果未配對，Gateway 回覆 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)。
3. 用戶端發送 `pair-request`。
4. Gateway 等待批准，然後發送 `pair-ok` 和 `hello-ok`。

`hello-ok` 返回 `serverName`，可能包含 `canvasHostUrl`。

## 影格

用戶端 → Gateway：

- `req` / `res`：範圍化 Gateway RPC (chat, 工作階段, 設定, health, voicewake, skills.bins)
- `event`：節點訊號 (語音轉錄、智慧代理 請求、chat 訂閱、exec 生命週期)

Gateway → 用戶端：

- `invoke` / `invoke-res`：節點 命令 (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event`：已訂閱 工作階段 的 chat 更新
- `ping` / `pong`：保持連線

舊版 允許列表執行存在於 `src/gateway/server-bridge.ts` 中 (已移除)。

## Exec 生命週期事件

節點可以發出 `exec.finished` 或 `exec.denied` 事件以呈現 system.run 活動。
這些被映射到 Gateway 中的系統事件。(舊版節點可能仍會發出 `exec.started`。)

酬載 欄位 (除非另有說明，否則皆為可選)：

- `sessionKey` (必填)：接收系統事件的 智慧代理 工作階段。
- `runId`：用於分組的唯一 exec ID。
- `command`：原始或格式化的 命令 字串。
- `exitCode`、`timedOut`、`success`、`output`：完成詳細資料 (僅限 finished)。
- `reason`：拒絕原因 (僅限 denied)。

## Tailnet 使用

- 將 Bridge 綁定到 tailnet IP：在 `~/.openclaw/openclaw.json` 中設定 `bridge.bind: "tailnet"`。
- 用戶端透過 MagicDNS 名稱或 tailnet IP 連接。
- Bonjour **不**跨 網路；需要時請使用手動主機/埠或廣域 DNS‑SD。

## 版本控制

Bridge 目前是**隱式 v1** (無最小/最大協商)。預期向後相容；在任何重大變更之前新增 Bridge 協定 版本欄位。
