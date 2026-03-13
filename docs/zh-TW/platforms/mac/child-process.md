---
summary: Gateway lifecycle on macOS (launchd)
read_when:
  - Integrating the mac app with the gateway lifecycle
title: Gateway Lifecycle
---

# macOS 上的 Gateway 生命週期

macOS 應用程式預設透過 launchd **管理 Gateway**，並不會以子程序方式啟動 Gateway。它會先嘗試連接到已在設定埠口上執行的 Gateway；如果無法連接，則會透過外部 `openclaw` CLI（無內嵌執行環境）啟用 launchd 服務。這樣可以確保在登入時自動啟動，並在崩潰時自動重啟。

子程序模式（由應用程式直接啟動 Gateway）目前**未使用**。如果需要與 UI 更緊密的結合，請手動在終端機中執行 Gateway。

## 預設行為（launchd）

- 應用程式會安裝一個以 `ai.openclaw.gateway` 標記的每用戶 LaunchAgent  
  （使用 `--profile`/`OPENCLAW_PROFILE` 時為 `ai.openclaw.<profile>`；也支援舊版 `com.openclaw.*`）。
- 啟用本地模式時，應用程式會確保 LaunchAgent 已載入，並在需要時啟動 Gateway。
- 日誌會寫入 launchd Gateway 日誌路徑（可在除錯設定中查看）。

常用指令：

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

執行命名設定檔時，請將標籤替換為 `ai.openclaw.<profile>`。

## 未簽章的開發版本

`scripts/restart-mac.sh --no-sign` 適用於沒有簽章金鑰時的快速本地建置。為避免 launchd 指向未簽章的 relay 執行檔，它會：

- 寫入 `~/.openclaw/disable-launchagent`。

已簽章的 `scripts/restart-mac.sh` 執行時若發現此標記，會清除此覆寫。若要手動重設：

```bash
rm ~/.openclaw/disable-launchagent
```

## 僅附加模式

若要強制 macOS 應用程式**永不安裝或管理 launchd**，請使用 `--attach-only`（或 `--no-launchd`）啟動。此設定會設置 `~/.openclaw/disable-launchagent`，使應用程式僅附加到已執行的 Gateway。你也可以在除錯設定中切換相同行為。

## 遠端模式

遠端模式不會啟動本地 Gateway。應用程式會使用 SSH 隧道連接到遠端主機，並透過該隧道進行連線。

## 為什麼我們偏好使用 launchd

- 登入時自動啟動。
- 內建重啟/保持存活（KeepAlive）機制。
- 日誌與監控行為可預期。

如果未來真的需要子程序模式，應該將其作為一個獨立且明確的僅限開發使用模式來記錄。
