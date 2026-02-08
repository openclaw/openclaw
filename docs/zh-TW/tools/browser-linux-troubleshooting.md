---
summary: 「修復 Linux 上用於 OpenClaw 瀏覽器控制的 Chrome / Brave / Edge / Chromium CDP 啟動問題」
read_when: 「在 Linux 上瀏覽器控制失敗，特別是使用 snap Chromium 時」
title: 「瀏覽器疑難排解」
x-i18n:
  source_path: tools/browser-linux-troubleshooting.md
  source_hash: bac2301022511a0b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:24Z
---

# 瀏覽器疑難排解（Linux）

## 問題：「Failed to start Chrome CDP on port 18800」

OpenClaw 的瀏覽器控制伺服器在啟動 Chrome / Brave / Edge / Chromium 時失敗，並顯示錯誤：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

在 Ubuntu（以及許多 Linux 發行版）上，預設的 Chromium 安裝是 **snap 套件**。Snap 的 AppArmor 侷限會干擾 OpenClaw 啟動與監控瀏覽器處理程序的方式。

`apt install chromium` 指令會安裝一個重新導向到 snap 的 stub 套件：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

這並不是一個真正的瀏覽器——它只是一個包裝器。

### 解決方案 1：安裝 Google Chrome（建議）

安裝官方的 Google Chrome `.deb` 套件，該套件不受 snap 沙箱限制：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

接著更新你的 OpenClaw 設定（`~/.openclaw/openclaw.json`）：

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### 解決方案 2：搭配「僅附加」模式使用 Snap Chromium

如果你必須使用 snap Chromium，請將 OpenClaw 設定為附加到手動啟動的瀏覽器：

1. 更新設定：

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. 手動啟動 Chromium：

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. （選用）建立 systemd 使用者服務以自動啟動 Chrome：

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

啟用方式：`systemctl --user enable --now openclaw-browser.service`

### 驗證瀏覽器是否正常運作

檢查狀態：

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

測試瀏覽：

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### 設定參考

| 選項                     | 說明                                                                | 預設值                                         |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| `browser.enabled`        | 啟用瀏覽器控制                                                      | `true`                                         |
| `browser.executablePath` | Chromium 系列瀏覽器二進位檔路徑（Chrome / Brave / Edge / Chromium） | 自動偵測（偏好 Chromium 系列的系統預設瀏覽器） |
| `browser.headless`       | 以無 GUI 模式執行                                                   | `false`                                        |
| `browser.noSandbox`      | 新增 `--no-sandbox` 旗標（某些 Linux 環境需要）                     | `false`                                        |
| `browser.attachOnly`     | 不啟動瀏覽器，只附加到既有實例                                      | `false`                                        |
| `browser.cdpPort`        | Chrome DevTools Protocol 連接埠                                     | `18800`                                        |

### 問題：「Chrome extension relay is running, but no tab is connected」

你正在使用 `chrome` 設定檔（extension relay）。它預期 OpenClaw
瀏覽器擴充功能會附加到一個正在運作的分頁。

修正方式：

1. **使用受管理的瀏覽器：** `openclaw browser start --browser-profile openclaw`
   （或設定 `browser.defaultProfile: "openclaw"`）。
2. **使用 extension relay：** 安裝擴充功能、開啟一個分頁，然後點擊
   OpenClaw 擴充功能圖示以進行附加。

注意事項：

- `chrome` 設定檔在可能的情況下會使用你的 **系統預設 Chromium 瀏覽器**。
- 本機 `openclaw` 設定檔會自動指派 `cdpPort` / `cdpUrl`；只有在遠端 CDP 時才需要設定這些選項。
