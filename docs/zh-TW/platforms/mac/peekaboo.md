---
summary: "用於 macOS UI 自動化的 PeekabooBridge 整合"
read_when:
  - 在 OpenClaw.app 中託管 PeekabooBridge
  - 透過 Swift Package Manager 整合 Peekaboo
  - 更改 PeekabooBridge 協定/路徑
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS UI 自動化)

OpenClaw 可以將 **PeekabooBridge** 作為本地且具備權限識別能力的 UI 自動化代理程式 (broker) 進行託管。這讓 `peekaboo` CLI 能夠在複用 macOS 應用程式的 TCC 權限的同時，驅動 UI 自動化。

## 這是什麼（以及它不是什麼）

- **主機 (Host)**：OpenClaw.app 可以作為 PeekabooBridge 主機。
- **用戶端 (Client)**：使用 `peekaboo` CLI（沒有獨立的 `openclaw ui ...` 介面）。
- **UI**：視覺疊加層 (overlays) 仍保留在 Peekaboo.app 中；OpenClaw 是個輕量級的代理主機。

## 啟用 Bridge

在 macOS 應用程式中：

- 設定 → **Enable Peekaboo Bridge**

啟用時，OpenClaw 會啟動一個本地 UNIX socket 伺服器。若停用，主機將停止，且 `peekaboo` 會切換至其他可用的主機。

## 用戶端探索順序

Peekaboo 用戶端通常按以下順序嘗試連接主機：

1. Peekaboo.app（完整體驗）
2. Claude.app（若已安裝）
3. OpenClaw.app（輕量級代理程式）

使用 `peekaboo bridge status --verbose` 即可查看目前啟用的主機以及正在使用的 socket 路徑。您可以使用以下方式進行覆蓋：

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 安全性與權限

- Bridge 會驗證**呼叫者的程式碼簽署 (code signatures)**；系統會強制執行 TeamID 允許清單（Peekaboo 主機 TeamID + OpenClaw 應用程式 TeamID）。
- 請求會在約 10 秒後逾時。
- 若缺少必要權限，Bridge 會傳回明確的錯誤訊息，而不會啟動「系統設定」。

## 快照行為（自動化）

快照會儲存在記憶體中，並在短時間後自動過期。若需要保留更長時間，請從用戶端重新擷取。

## 疑難排解

- 若 `peekaboo` 報告「bridge client is not authorized」，請確保用戶端已正確簽署，或僅在 **debug** 模式下使用 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 執行主機。
- 若找不到主機，請開啟其中一個主機應用程式（Peekaboo.app 或 OpenClaw.app）並確認權限已授權。
