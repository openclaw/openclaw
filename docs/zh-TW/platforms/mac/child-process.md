---
summary: "macOS 上的 Gateway 生命週期 (launchd)"
read_when:
  - 將 Mac 應用程式與 Gateway 生命週期整合時
title: "Gateway 生命週期"
---

# macOS 上的 Gateway 生命週期

macOS 應用程式預設情況下**透過 launchd 管理 Gateway**，並且不會將 Gateway 作為子程序啟動。它首先嘗試連接到設定埠上已在執行的 Gateway；如果無法連線到任何 Gateway，它會透過外部 `openclaw` CLI 啟用 launchd 服務（無嵌入式運行時）。這讓您可以在登入時可靠地自動啟動，並在崩潰時重新啟動。

子程序模式（由應用程式直接啟動的 Gateway）目前**未在使用**。如果您需要與 UI 更緊密的耦合，請在終端機中手動執行 Gateway。

## 預設行為 (launchd)

- 應用程式會安裝一個標記為 `bot.molt.gateway` 的每位使用者 LaunchAgent
  （或在使用 `--profile`/`OPENCLAW_PROFILE` 時標記為 `bot.molt.<profile>`；支援舊版 `com.openclaw.*`）。
- 當啟用本機模式時，應用程式會確保 LaunchAgent 已載入並在需要時啟動 Gateway。
- 日誌會寫入 launchd gateway 日誌路徑（可在除錯設定中查看）。

常用命令：

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

當執行具名設定檔時，請將標籤替換為 `bot.molt.<profile>`。

## 未簽署的開發版本

`scripts/restart-mac.sh --no-sign` 用於在沒有簽署金鑰時進行快速本機建置。為了防止 launchd 指向未簽署的中繼二進位檔案，它會：

- 寫入 `~/.openclaw/disable-launchagent`。

已簽署的 `scripts/restart-mac.sh` 執行如果標記存在，將清除此覆寫。若要手動重設：

```bash
rm ~/.openclaw/disable-launchagent
```

## 僅連接模式

若要強制 macOS 應用程式**永遠不安裝或管理 launchd**，請使用 `--attach-only`（或 `--no-launchd`）啟動它。這會設定 `~/.openclaw/disable-launchagent`，因此應用程式只會連接到已在執行的 Gateway。您可以在除錯設定中切換此行為。

## 遠端模式

遠端模式永遠不會啟動本機 Gateway。應用程式會使用 SSH 通道連接到遠端主機並透過該通道進行連線。

## 我們偏好 launchd 的原因

- 登入時自動啟動。
- 內建重新啟動/保持連線語義。
- 可預測的日誌和監督。

如果未來再次需要真正的子程序模式，應將其文件化為一個獨立的、明確的僅限開發模式。
