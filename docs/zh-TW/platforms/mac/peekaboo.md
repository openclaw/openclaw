---
summary: PeekabooBridge integration for macOS UI automation
read_when:
  - Hosting PeekabooBridge in OpenClaw.app
  - Integrating Peekaboo via Swift Package Manager
  - Changing PeekabooBridge protocol/paths
title: Peekaboo Bridge
---

# Peekaboo Bridge（macOS UI 自動化）

OpenClaw 可以作為本地、具權限感知的 UI 自動化代理主機 **PeekabooBridge**。這讓 `peekaboo` CLI 能夠驅動 UI 自動化，同時重用 macOS 應用程式的 TCC 權限。

## 這是什麼（以及不是什麼）

- **主機**：OpenClaw.app 可以作為 PeekabooBridge 的主機。
- **用戶端**：使用 `peekaboo` CLI（無獨立的 `openclaw ui ...` 介面）。
- **UI**：視覺覆蓋層保留在 Peekaboo.app；OpenClaw 僅是輕量的代理主機。

## 啟用橋接

在 macOS 應用程式中：

- 設定 → **啟用 Peekaboo Bridge**

啟用後，OpenClaw 會啟動本地 UNIX socket 伺服器。若停用，主機將停止，`peekaboo` 將回退使用其他可用主機。

## 用戶端尋找順序

Peekaboo 用戶端通常會依照以下順序嘗試主機：

1. Peekaboo.app（完整使用者體驗）
2. Claude.app（若已安裝）
3. OpenClaw.app（輕量代理）

使用 `peekaboo bridge status --verbose` 可查看目前啟用的主機及使用中的 socket 路徑。你也可以用以下方式覆寫：

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 安全性與權限

- 桥接會驗證 **呼叫者的程式碼簽章**；並強制執行 TeamID 白名單（包含 Peekaboo 主機 TeamID 與 OpenClaw 應用程式 TeamID）。
- 請求會在約 10 秒後逾時。
- 若缺少必要權限，橋接會回傳明確的錯誤訊息，而非啟動系統設定。

## 快照行為（自動化）

快照會儲存在記憶體中，並在短時間後自動過期。
如果需要更長時間的保留，請從用戶端重新擷取。

## 疑難排解

- 如果 `peekaboo` 顯示「bridge client 未被授權」，請確保用戶端已正確簽署，或僅在 **debug** 模式下使用 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 執行主機。
- 如果找不到任何主機，請打開其中一個主機應用程式（Peekaboo.app 或 OpenClaw.app），並確認已授予權限。
