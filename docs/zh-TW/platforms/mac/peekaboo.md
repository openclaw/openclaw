---
summary: "PeekabooBridge 與 macOS UI 自動化的整合"
read_when:
  - 在 OpenClaw.app 中託管 PeekabooBridge
  - 透過 Swift Package Manager 整合 Peekaboo
  - 變更 PeekabooBridge 通訊協定／路徑
title: "Peekaboo Bridge"
---

# Peekaboo Bridge（macOS UI 自動化）

OpenClaw can host **PeekabooBridge** as a local, permission‑aware UI automation
broker. OpenClaw 可將 **PeekabooBridge** 作為本機、具備權限感知的 UI 自動化
代理來託管。這讓 `peekaboo` CLI 能夠驅動 UI 自動化，同時重用
macOS 應用程式的 TCC 權限。

## 這是什麼（以及不是什麼）

- **Host**：OpenClaw.app 可作為 PeekabooBridge 的 Host。
- **Client**：使用 `peekaboo` CLI（沒有獨立的 `openclaw ui ...` 介面）。
- **UI**：視覺覆蓋層仍留在 Peekaboo.app；OpenClaw 是精簡的代理 Host。

## 啟用 Bridge

在 macOS 應用程式中：

- 設定 → **啟用 Peekaboo Bridge**

When enabled, OpenClaw starts a local UNIX socket server. If disabled, the host
is stopped and `peekaboo` will fall back to other available hosts.

## Client 探索順序

Peekaboo Client 通常依下列順序嘗試 Host：

1. Peekaboo.app（完整 UX）
2. Claude.app（若已安裝）
3. OpenClaw.app（精簡代理）

使用 `peekaboo bridge status --verbose` 檢視目前啟用的 Host 以及
正在使用的 socket 路徑。你也可以覆寫為： You can override with:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 安全性與權限

- Bridge 會驗證 **呼叫端程式碼簽章**；並強制套用 TeamID 的允許清單
  （Peekaboo Host TeamID + OpenClaw 應用程式 TeamID）。
- 請求在約 10 秒後逾時。
- 若缺少必要權限，Bridge 會回傳清楚的錯誤訊息，而不會啟動「系統設定」。

## 快照行為（自動化）

Snapshots are stored in memory and expire automatically after a short window.
If you need longer retention, re‑capture from the client.

## Troubleshooting

- 若 `peekaboo` 回報「bridge client is not authorized」，請確認 Client
  已正確簽署，或僅在 **debug** 模式下使用 `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` 來執行 Host。
- 若找不到任何 Host，請開啟其中一個 Host 應用程式（Peekaboo.app 或 OpenClaw.app）
  並確認已授予權限。
