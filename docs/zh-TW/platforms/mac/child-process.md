---
summary: "macOS 上的 Gateway 生命週期 (launchd)"
read_when:
  - 將 Mac 應用程式與 Gateway 生命週期整合時
title: "Gateway 生命週期"
---

# macOS 上的 Gateway 生命週期

macOS 應用程式預設**透過 launchd 管理 Gateway**，且不會將 Gateway 作為子程序產生。它會先嘗試附加到已在設定連接埠上執行的 Gateway；如果無法連線，則會透過外部的 `openclaw` CLI（無內嵌執行環境）啟用 launchd 服務。這為您提供了可靠的登入自動啟動以及崩潰時的重新啟動機制。

目前**未使用**子程序模式（由應用程式直接產生 Gateway）。如果您需要與 UI 更緊密結合，請在終端機中手動執行 Gateway。

## 預設行為 (launchd)

- 應用程式會安裝一個標籤為 `bot.molt.gateway` 的每個使用者 LaunchAgent（或在使用 `--profile`/`OPENCLAW_PROFILE` 時標籤為 `bot.molt.<profile>`；支援舊有的 `com.openclaw.*`）。
- 當啟用本地模式 (Local mode) 時，應用程式會確保 LaunchAgent 已載入，並在需要時啟動 Gateway。
- 紀錄會寫入 launchd gateway 紀錄路徑（可在偵錯設定中查看）。

常見指令：

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

在執行命名的設定檔 (profile) 時，請將標籤替換為 `bot.molt.<profile>`。

## 未簽署的開發編譯版本

`scripts/restart-mac.sh --no-sign` 用於沒有簽署金鑰時的快速本地編譯。為了防止 launchd 指向未簽署的 relay 二進位檔案，它會：

- 寫入 `~/.openclaw/disable-launchagent`。

如果該標記存在，已簽署執行的 `scripts/restart-mac.sh` 會清除此覆蓋。若要手動重設：

```bash
rm ~/.openclaw/disable-launchagent
```

## 僅附加模式 (Attach-only mode)

若要強制 macOS 應用程式**絕不安裝或管理 launchd**，請使用 `--attach-only`（或 `--no-launchd`）啟動它。這會設定 `~/.openclaw/disable-launchagent`，使應用程式僅附加到已在執行的 Gateway。您也可以在偵錯設定中切換此行為。

## 遠端模式 (Remote mode)

遠端模式絕不會啟動本地 Gateway。應用程式會建立到遠端主機的 SSH 通道，並透過該通道進行連線。

## 為什麼我們偏好使用 launchd

- 登入時自動啟動。
- 內建的重新啟動/保持存活 (KeepAlive) 語義。
- 可預測的紀錄與監控。

如果以後需要真正的子程序模式，應將其記錄為一個獨立且明確的僅限開發 (dev-only) 模式。
