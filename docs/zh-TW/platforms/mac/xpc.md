---
summary: >-
  macOS IPC architecture for OpenClaw app, gateway node transport, and
  PeekabooBridge
read_when:
  - Editing IPC contracts or menu bar app IPC
title: macOS IPC
---

# OpenClaw macOS IPC 架構

**目前模型：**一個本地 Unix socket 將 **node host service** 連接到 **macOS 應用程式**，用於執行授權 + `system.run`。存在一個 `openclaw-mac` 除錯 CLI 用於發現/連線檢查；代理動作仍透過 Gateway WebSocket 和 `node.invoke` 流動。UI 自動化使用 PeekabooBridge。

## 目標

- 單一 GUI 應用程式實例，負責所有面向 TCC 的工作（通知、螢幕錄製、麥克風、語音、AppleScript）。
- 簡潔的自動化介面：Gateway + node 指令，外加 PeekabooBridge 用於 UI 自動化。
- 可預測的權限：始終使用相同簽署的 bundle ID，由 launchd 啟動，確保 TCC 授權持續有效。

## 運作方式

### Gateway + node 傳輸

- 應用程式執行 Gateway（本地模式）並以 node 身份連接。
- 代理動作透過 `node.invoke` 執行（例如 `system.run`、`system.notify`、`canvas.*`）。

### Node 服務 + 應用程式 IPC

- 一個無頭的 node host 服務連接到 Gateway WebSocket。
- `system.run` 請求透過本地 Unix socket 轉發到 macOS 應用程式。
- 應用程式在 UI 環境中執行指令，必要時提示使用者，並回傳輸出結果。

圖示 (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI 自動化）

- UI 自動化使用名為 `bridge.sock` 的獨立 UNIX socket 及 PeekabooBridge JSON 協定。
- 主機偏好順序（用戶端）：Peekaboo.app → Claude.app → OpenClaw.app → 本地執行。
- 安全性：橋接主機需允許的 TeamID；僅 DEBUG 模式下的同 UID 逃脫通道由 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（Peekaboo 約定）保護。
- 詳見：[PeekabooBridge 使用說明](/platforms/mac/peekaboo)。

## 操作流程

- 重啟/重建：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 終止現有實例
  - Swift 編譯 + 打包
  - 寫入/引導/啟動 LaunchAgent
- 單一實例：若已有相同 bundle ID 的實例執行中，應用程式會提前退出。

## 強化說明

- 優先要求所有特權介面必須符合 TeamID。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（僅限 DEBUG）可能允許相同 UID 的呼叫者用於本地開發。
- 所有通訊皆維持本地限定；不會開放任何網路 socket。
- TCC 提示僅來自 GUI 應用程式包；請保持簽署的 bundle ID 在重建時穩定。
- IPC 強化：socket 模式 `0600`、token、對等 UID 檢查、HMAC 挑戰/回應、短 TTL。
