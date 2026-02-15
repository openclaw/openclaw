---
summary: "PeekabooBridge 整合至 macOS UI 自動化"
read_when:
  - 在 OpenClaw.app 中託管 PeekabooBridge
  - 透過 Swift Package Manager 整合 Peekaboo
  - 變更 PeekabooBridge 協定/路徑
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (macOS UI 自動化)

OpenClaw 可以託管 **PeekabooBridge** 作為一個本機、具備權限意識的 UI 自動化中介。這讓 `peekaboo` CLI 在重用 macOS 應用程式的 TCC 權限的同時，能夠驅動 UI 自動化。

## 這是什麼 (以及不是什麼)

- **主機**: OpenClaw.app 可以作為 PeekabooBridge 主機。
- **用戶端**: 使用 `peekaboo` CLI (沒有獨立的 `openclaw ui ...` 介面)。
- **UI**: 視覺疊加層保留在 Peekaboo.app 中；OpenClaw 是一個輕量級的中介主機。

## 啟用橋接

在 macOS 應用程式中：

- 設定 → **啟用 Peekaboo Bridge**

啟用後，OpenClaw 會啟動一個本機 UNIX socket 伺服器。如果停用，主機將停止，且 `peekaboo` 會退回到其他可用的主機。

## 用戶端裝置探索順序

Peekaboo 用戶端通常依此順序嘗試主機：

1.  Peekaboo.app (完整使用者體驗)
2.  Claude.app (如果已安裝)
3.  OpenClaw.app (輕量級中介)

使用 `peekaboo bridge status --verbose` 來查看哪個主機處於活動狀態以及正在使用哪個 socket 路徑。您可以透過以下方式覆寫：

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 安全性與權限

- 橋接驗證了**呼叫者的程式碼簽章**；強制執行 TeamID 允許清單 (Peekaboo 主機 TeamID + OpenClaw 應用程式 TeamID)。
- 請求在約 10 秒後逾時。
- 如果缺少所需的權限，橋接會傳回清晰的錯誤訊息，而不是啟動「系統設定」。

## 快照行為 (自動化)

快照儲存在記憶體中，並在短時間視窗後自動過期。如果您需要更長的保留時間，請從用戶端重新擷取。

## 疑難排解

- 如果 `peekaboo` 報告「橋接用戶端未經授權」，請確保用戶端已正確簽署，或僅在 **debug** 模式下使用 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 執行主機。
- 如果找不到主機，請打開其中一個主機應用程式 (Peekaboo.app 或 OpenClaw.app) 並確認已授予權限。
