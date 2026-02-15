---
summary: "OpenClaw 應用程式、Gateway 節點傳輸以及 PeekabooBridge 的 macOS IPC 架構"
read_when:
  - 編輯 IPC 合約或選單列應用程式 IPC 時
title: "macOS IPC"
---

# OpenClaw macOS IPC 架構

**目前模型：** 使用本地 Unix socket 將 **節點主機服務** 連接至 **macOS 應用程式**，用於執行授權與 `system.run`。現有一個 `openclaw-mac` 除錯 CLI 用於探索/連線檢查；智慧代理動作仍透過 Gateway WebSocket 與 `node.invoke` 傳輸。UI 自動化使用 PeekabooBridge。

## 目標

- 由單一 GUI 應用程式實例負責所有面向 TCC 的工作（通知、螢幕錄製、麥克風、語音、AppleScript）。
- 一個小型的自動化介面：Gateway + 節點指令，加上用於 UI 自動化的 PeekabooBridge。
- 可預測的權限：始終使用相同的已簽署 bundle ID，並由 launchd 啟動，確保 TCC 授權持續有效。

## 運作原理

### Gateway + 節點傳輸

- 應用程式執行 Gateway（本地模式）並以節點身份連線。
- 智慧代理動作透過 `node.invoke` 執行（例如 `system.run`、`system.notify`、`canvas.*`）。

### 節點服務 + 應用程式 IPC

- 一個無介面（headless）節點主機服務連線至 Gateway WebSocket。
- `system.run` 請求透過本地 Unix socket 轉發至 macOS 應用程式。
- 應用程式在 UI 上下文中執行程式，視需要彈出提示，並回傳輸出。

圖表 (SCI)：

```
智慧代理 -> Gateway -> 節點服務 (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI 自動化)

- UI 自動化使用名為 `bridge.sock` 的獨立 UNIX socket 與 PeekabooBridge JSON 協定。
- 主機優先順序（客戶端）：Peekaboo.app → Claude.app → OpenClaw.app → 本地執行。
- 安全性：Bridge 主機需要允許的 TeamID；僅限 DEBUG 的相同 UID 逃生門受 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 保護（Peekaboo 慣例）。
- 請參閱：[PeekabooBridge 使用方法](/platforms/mac/peekaboo) 了解詳情。

## 作業流程

- 重新啟動/重新建置：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - 終止現有實例
  - Swift 建置 + 打包
  - 寫入/引導/啟動 LaunchAgent
- 單一實例：若已有相同 bundle ID 的另一個實例正在執行，應用程式將提前退出。

## 強化說明

- 建議所有具備權限的介面都要求 TeamID 匹配。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（僅限 DEBUG）可能允許相同 UID 的呼叫者進行本地開發。
- 所有通訊保持僅限本地；不暴露任何網路 socket。
- TCC 提示僅由 GUI 應用程式 bundle 發出；在重新建置過程中請保持已簽署 bundle ID 的穩定性。
- IPC 強化：socket 模式 `0600`、權杖（token）、對等 UID 檢查、HMAC 挑戰/回應、短 TTL。
