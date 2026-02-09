---
summary: "OpenClaw macOS 應用程式、Gateway 閘道器節點傳輸與 PeekabooBridge 的 macOS IPC 架構"
read_when:
  - 編輯 IPC 合約或選單列應用程式 IPC
title: "macOS IPC"
---

# OpenClaw macOS IPC 架構

**目前模型：** 以本機 Unix socket 連接 **node host service** 與 **macOS 應用程式**，用於 exec 核准 + `system.run`。另有一個 `openclaw-mac` 偵錯 CLI，供探索／連線檢查；代理程式動作仍透過 Gateway WebSocket 與 `node.invoke` 流動。UI 自動化使用 PeekabooBridge。 A `openclaw-mac` debug CLI exists for discovery/connect checks; agent actions still flow through the Gateway WebSocket and `node.invoke`. UI automation uses PeekabooBridge.

## 目標

- 單一 GUI 應用程式實例，負責所有面向 TCC 的工作（通知、螢幕錄製、麥克風、語音、 AppleScript）。
- 精簡的自動化介面：Gateway + node 指令，另以 PeekabooBridge 進行 UI 自動化。
- 可預期的權限：一律使用相同已簽署的 bundle ID，由 launchd 啟動，確保 TCC 授權可持續。

## How it works

### Gateway + node 傳輸

- 應用程式執行 Gateway（本機模式），並作為一個 node 連線至它。
- 代理程式動作透過 `node.invoke` 執行（例如 `system.run`、`system.notify`、`canvas.*`）。

### Node 服務 + 應用程式 IPC

- 無介面的 node host service 連線至 Gateway WebSocket。
- `system.run` 請求會透過本機 Unix socket 轉送至 macOS 應用程式。
- The app performs the exec in UI context, prompts if needed, and returns output.

圖示（SCI）：

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge（UI 自動化）

- UI 自動化使用名為 `bridge.sock` 的獨立 UNIX socket，以及 PeekabooBridge JSON 協定。
- 主機偏好順序（用戶端）：Peekaboo.app → Claude.app → OpenClaw.app → 本機執行。
- 安全性：Bridge 主機需在允許的 TeamID 清單中；僅限 DEBUG 的同 UID 逃生門由 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 防護（Peekaboo 慣例）。
- 詳細資訊請參閱：[PeekabooBridge 使用方式](/platforms/mac/peekaboo)。

## 操作流程

- 重新啟動／重建：`SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Kills existing instances
  - Swift 建置 + 封裝
  - 寫入／啟動／kickstart LaunchAgent
- 單一實例：若已有相同 bundle ID 的實例在執行，應用程式會提前結束。

## 強化注意事項

- 偏好對所有具權限的介面要求 TeamID 相符。
- PeekabooBridge：`PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`（僅限 DEBUG）可在本機開發時允許同 UID 呼叫者。
- 所有通訊皆維持僅限本地；不暴露任何網路通訊端。
- TCC 提示僅由 GUI 應用程式 bundle 發起；重建時請保持已簽署的 bundle ID 穩定。
- IPC 強化：socket 模式 `0600`、權杖、對等 UID 檢查、HMAC 挑戰／回應、短 TTL。
