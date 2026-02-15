---
summary: "OpenClaw 應用程式、Gateway 節點傳輸和 PeekabooBridge 的 macOS IPC 架構"
read_when:
  - 編輯 IPC 合約或選單列應用程式 IPC
title: "macOS IPC"
---

# OpenClaw macOS IPC 架構

**目前模型：** 一個本機 Unix socket 將**節點主機服務**連接到 **macOS 應用程式**，用於執行核准和 `system.run`。存在一個 `openclaw-mac` 偵錯 CLI 用於裝置探索/連接檢查；智慧代理動作仍透過 Gateway WebSocket 和 `node.invoke` 進行。UI 自動化使用 PeekabooBridge。

## 目標

- 單一 GUI 應用程式實例，擁有所有面向 TCC 的工作（通知、螢幕錄影、麥克風、語音、AppleScript）。
- 一個用於自動化的小型介面：Gateway + 節點命令，以及用於 UI 自動化的 PeekabooBridge。
- 可預測的權限：始終相同的簽名 bundle ID，由 launchd 啟動，因此 TCC 授權會保持。

## 運作方式

### Gateway + 節點傳輸

- 應用程式運行 Gateway（本機模式）並將其連接為一個節點。
- 智慧代理動作透過 `node.invoke` 執行（例如 `system.run`、`system.notify`、`canvas.*`）。

### 節點服務 + 應用程式 IPC

- 一個無頭節點主機服務連接到 Gateway WebSocket。
- `system.run` 請求透過本機 Unix socket 轉發到 macOS 應用程式。
- 應用程式在 UI 環境中執行，如果需要則提示，並返回輸出。

示意圖 (SCI)：

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI 自動化)

- UI 自動化使用一個名為 `bridge.sock` 的獨立 UNIX socket 和 PeekabooBridge JSON 協定。
- 主機偏好順序（客戶端）：Peekaboo.app → Claude.app → OpenClaw.app → 本機執行。
- 安全性：橋接主機需要允許的 TeamID；僅限偵錯的相同 UID 逃生艙口受 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 保護（Peekaboo 慣例）。
- 了解詳情：[PeekabooBridge 使用方式](/platforms/mac/peekaboo)。

## 操作流程

- 重新啟動/重建：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 終止現有實例
  - Swift 建置 + 打包
  - 寫入/啟動/啟用 LaunchAgent
- 單一實例：如果存在具有相同 bundle ID 的其他實例正在運行，應用程式會提前退出。

## 強化注意事項

- 優先要求所有特權介面都必須符合 TeamID。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (僅限偵錯) 可能允許相同 UID 呼叫者進行本機開發。
- 所有通訊僅限於本機；沒有網路 socket 暴露。
- TCC 提示僅來自 GUI 應用程式 bundle；在重建時保持簽名 bundle ID 穩定。
- IPC 強化：socket 模式 `0600`、token、peer-UID 檢查、HMAC 挑戰/回應、短 TTL。
