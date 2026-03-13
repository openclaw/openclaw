---
summary: "Bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Building or debugging node clients (iOS/Android/macOS node mode)
  - Investigating pairing or bridge auth failures
  - Auditing the node surface exposed by the gateway
title: Bridge Protocol
---

# Bridge 協議（舊版節點傳輸）

Bridge 協議是一種 **舊版** 節點傳輸 (TCP JSONL)。新的節點用戶端應該改用統一的 Gateway WebSocket 協議。

如果您正在建立運算子或節點用戶端，請使用 [Gateway protocol](/gateway/protocol)。

**注意：** 當前的 OpenClaw 版本不再包含 TCP 橋接聽器；此文件僅供歷史參考。舊版 `bridge.*` 設定鍵不再是設定架構的一部分。

## 為什麼我們有兩者

- **安全邊界**：該橋接僅暴露一小部分允許清單，而不是完整的網關 API 表面。
- **配對 + 節點身份**：節點的入網由網關擁有，並與每個節點的 token 綁定。
- **發現使用者體驗**：節點可以通過 LAN 上的 Bonjour 發現網關，或直接通過 tailnet 連接。
- **回環 WS**：完整的 WS 控制平面保持在本地，除非通過 SSH 隧道。

## Transport

- TCP，每行一個 JSON 物件 (JSONL)。
- 可選的 TLS (當 `bridge.tls.enabled` 為真時)。
- 傳統的預設監聽埠是 `18790` (目前的版本不啟動 TCP 橋接)。

當啟用 TLS 時，發現的 TXT 記錄包括 `bridgeTls=1` 以及 `bridgeTlsSha256` 作為非秘密提示。請注意，Bonjour/mDNS 的 TXT 記錄是未經身份驗證的；用戶端不應將廣告的指紋視為權威的釘選，除非有明確的用戶意圖或其他帶外驗證。

## Handshake + 配對

1. 用戶端發送 `hello` 連同節點元數據 + token（如果已經配對）。
2. 如果尚未配對，閘道器回覆 `error` (`NOT_PAIRED`/`UNAUTHORIZED`)。
3. 用戶端發送 `pair-request`。
4. 閘道器等待批准，然後發送 `pair-ok` 和 `hello-ok`。

`hello-ok` 會返回 `serverName`，並可能包含 `canvasHostUrl`。

## Frames

Client → Gateway:

- `req` / `res`: 範圍網關 RPC (聊天、會話、設定、健康、語音喚醒、技能.二進位)
- `event`: 節點信號 (語音轉錄、代理請求、聊天訂閱、執行生命週期)

[[BLOCK_1]]

- `invoke` / `invoke-res`: 節點指令 (`canvas.*`, `camera.*`, `screen.record`, `location.get`, `sms.send`)
- `event`: 訂閱會話的聊天更新
- `ping` / `pong`: 保持連線

Legacy allowlist enforcement lived in `src/gateway/server-bridge.ts`（已移除）。

## Exec 生命週期事件

節點可以發出 `exec.finished` 或 `exec.denied` 事件以顯示 system.run 活動。這些事件在網關中映射為系統事件。（舊版節點可能仍會發出 `exec.started`。）

Payload 欄位（除非另有註明，否則皆為選填）：

- `sessionKey` (必填): 用於接收系統事件的代理會話。
- `runId`: 用於分組的唯一執行 ID。
- `command`: 原始或格式化的命令字串。
- `exitCode`, `timedOut`, `success`, `output`: 完成詳情（僅限完成時）。
- `reason`: 拒絕原因（僅限拒絕時）。

## Tailnet 使用方法

- 將橋接器綁定到 tailnet IP: `bridge.bind: "tailnet"` 在 `~/.openclaw/openclaw.json` 中。
- 用戶端可以通過 MagicDNS 名稱或 tailnet IP 進行連接。
- Bonjour 不會跨越網路；在需要時請使用手動主機/端口或廣域 DNS‑SD。

## 版本控制

Bridge 目前是 **implicit v1**（沒有最小/最大協商）。預期會有向後相容性；在任何破壞性變更之前，請添加一個橋接協議版本欄位。
