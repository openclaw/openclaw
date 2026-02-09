---
summary: "macOS 上的 Gateway 生命週期（launchd）"
read_when:
  - 整合 mac 應用程式與 Gateway 生命週期
title: "Gateway 生命週期"
---

# macOS 上的 Gateway 生命週期

macOS 應用程式**預設透過 launchd 管理 Gateway**，而不是將 Gateway 以子行程方式啟動。它會先嘗試連線到設定連接埠上已在執行中的 Gateway；若沒有可連線的實例，則會透過外部的 `openclaw` CLI（無內嵌執行階段）啟用 launchd 服務。這可在登入時可靠地自動啟動，並在當機時重新啟動。 It first tries to attach to an already‑running
Gateway on the configured port; if none is reachable, it enables the launchd
service via the external `openclaw` CLI (no embedded runtime). This gives you
reliable auto‑start at login and restart on crashes.

Child‑process mode (Gateway spawned directly by the app) is **not in use** today.
If you need tighter coupling to the UI, run the Gateway manually in a terminal.

## 預設行為（launchd）

- 應用程式會安裝一個每位使用者的 LaunchAgent，標籤為 `bot.molt.gateway`
  （使用 `--profile`/`OPENCLAW_PROFILE` 時為 `bot.molt.<profile>`；仍支援舊版的 `com.openclaw.*`）。
- 啟用 Local 模式時，應用程式會確保 LaunchAgent 已載入，並在需要時啟動 Gateway。
- 記錄會寫入 launchd 的 Gateway 記錄路徑（可在 Debug Settings 中查看）。

常用指令：

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

使用具名設定檔執行時，請將標籤替換為 `bot.molt.<profile> `。\` when running a named profile.

## 未簽署的開發版本

`scripts/restart-mac.sh --no-sign` 用於在沒有簽署金鑰時進行快速的本機建置。為避免 launchd 指向未簽署的 relay 二進位檔，它會： To prevent launchd from pointing at an unsigned relay binary, it:

- 寫入 `~/.openclaw/disable-launchagent`。

`scripts/restart-mac.sh` 的已簽署執行會在偵測到該標記存在時清除此覆寫。若要手動重設： To reset manually:

```bash
rm ~/.openclaw/disable-launchagent
```

## 僅附加模式

To force the macOS app to **never install or manage launchd**, launch it with
`--attach-only` (or `--no-launchd`). This sets `~/.openclaw/disable-launchagent`,
so the app only attaches to an already running Gateway. You can toggle the same
behavior in Debug Settings.

## 遠端模式

遠端模式永遠不會啟動本機 Gateway。應用程式會使用 SSH 通道連線到遠端主機，並透過該通道進行連線。 The app uses an SSH tunnel to the
remote host and connects over that tunnel.

## 為何我們偏好 launchd

- 登入時自動啟動。
- 內建的重新啟動／KeepAlive 語意。
- Predictable logs and supervision.

If a true child‑process mode is ever needed again, it should be documented as a
separate, explicit dev‑only mode.
