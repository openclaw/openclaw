---
summary: 「橋接通訊協定（舊版節點）：TCP JSONL、配對、具範圍的 RPC」
read_when:
  - 建置或除錯節點用戶端（iOS/Android/macOS 節點模式）
  - 調查配對或橋接身分驗證失敗
  - 稽核 Gateway 閘道器所暴露的節點介面
title: 「橋接通訊協定」
x-i18n:
  source_path: gateway/bridge-protocol.md
  source_hash: 789bcf3cbc6841fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:00Z
---

# 橋接通訊協定（舊版節點傳輸）

橋接通訊協定是一種 **舊版** 的節點傳輸（TCP JSONL）。新的節點用戶端
應改用統一的 Gateway WebSocket 傳輸協定。

如果你正在建置營運工具或節點用戶端，請使用
[Gateway protocol](/gateway/protocol)。

**注意事項：** 目前的 OpenClaw 版本已不再隨附 TCP 橋接監聽器；此文件僅保留作為歷史參考。
舊版的 `bridge.*` 設定金鑰已不再屬於設定結構描述的一部分。

## 為何同時存在兩者

- **安全邊界**：橋接僅暴露小型的允許清單，而非完整的 Gateway 閘道器 API 介面。
- **配對與節點身分**：節點的准入由 Gateway 閘道器管理，並綁定到每個節點的權杖。
- **探索體驗（UX）**：節點可透過 LAN 上的 Bonjour 探索 Gateway 閘道器，或經由 tailnet 直接連線。
- **Loopback WS**：完整的 WS 控制平面除非透過 SSH 通道，否則會維持在本機。

## 傳輸

- TCP，每行一個 JSON 物件（JSONL）。
- 可選 TLS（當 `bridge.tls.enabled` 為 true 時）。
- 舊版預設監聽連接埠為 `18790`（目前版本不會啟動 TCP 橋接）。

啟用 TLS 時，探索用的 TXT 記錄會包含 `bridgeTls=1` 以及
`bridgeTlsSha256`，以便節點能夠釘選憑證。

## 交握與配對

1. 用戶端送出 `hello`，包含節點中繼資料與權杖（若已完成配對）。
2. 若尚未配對，Gateway 閘道器回覆 `error`（`NOT_PAIRED`/`UNAUTHORIZED`）。
3. 用戶端送出 `pair-request`。
4. Gateway 閘道器等待核准，接著送出 `pair-ok` 與 `hello-ok`。

`hello-ok` 會回傳 `serverName`，且可能包含 `canvasHostUrl`。

## 框架（Frames）

用戶端 → Gateway 閘道器：

- `req` / `res`：具範圍的 Gateway RPC（聊天、工作階段、設定、健康狀態、voicewake、skills.bins）
- `event`：節點訊號（語音逐字稿、代理程式請求、聊天訂閱、exec 生命週期）

Gateway 閘道器 → 用戶端：

- `invoke` / `invoke-res`：節點指令（`canvas.*`、`camera.*`、`screen.record`、
  `location.get`、`sms.send`）
- `event`：已訂閱工作階段的聊天更新
- `ping` / `pong`：保活（keepalive）

舊版的允許清單強制機制位於 `src/gateway/server-bridge.ts`（已移除）。

## Exec 生命週期事件

節點可以送出 `exec.finished` 或 `exec.denied` 事件，以呈現 system.run 的活動。
這些事件會對應到 Gateway 閘道器中的系統事件。（舊版節點仍可能送出 `exec.started`。）

負載欄位（除特別註明外皆為選填）：

- `sessionKey`（必填）：接收系統事件的代理程式工作階段。
- `runId`：用於分組的唯一 exec id。
- `command`：原始或格式化的指令字串。
- `exitCode`、`timedOut`、`success`、`output`：完成詳細資訊（僅在 finished 時）。
- `reason`：拒絕原因（僅在 denied 時）。

## Tailnet 使用方式

- 將橋接綁定至 tailnet IP：在 `~/.openclaw/openclaw.json` 中設定 `bridge.bind: "tailnet"`。
- 用戶端可透過 MagicDNS 名稱或 tailnet IP 連線。
- Bonjour **不會** 跨網路；必要時請使用手動主機/連接埠或廣域 DNS‑SD。

## 版本控管

橋接目前為 **隱含 v1**（未進行最小/最大版本協商）。預期會維持向後相容；
在任何破壞性變更之前，應先新增橋接通訊協定版本欄位。
