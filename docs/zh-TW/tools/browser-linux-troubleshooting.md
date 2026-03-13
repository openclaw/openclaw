---
summary: >-
  Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control
  on Linux
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: Browser Troubleshooting
---

# 瀏覽器故障排除（Linux）

## 問題：「無法在埠號 18800 啟動 Chrome CDP」

OpenClaw 的瀏覽器控制伺服器啟動 Chrome/Brave/Edge/Chromium 時失敗，並出現錯誤：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

在 Ubuntu（以及許多 Linux 發行版）中，預設的 Chromium 安裝是以 **snap 套件** 形式存在。Snap 的 AppArmor 限制會干擾 OpenClaw 啟動及監控瀏覽器程序的方式。

`apt install chromium` 指令會安裝一個轉向 snap 的 stub 套件：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

這並不是真正的瀏覽器 — 它只是個包裝器。

### 解決方案 1：安裝 Google Chrome（推薦）

安裝官方的 Google Chrome `.deb` 套件，該套件不受 snap 沙箱限制：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

接著更新你的 OpenClaw 設定 (`~/.openclaw/openclaw.json`)：

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

### 解決方案 2：使用 Snap Chromium 的僅附加模式

如果你必須使用 snap 版本的 Chromium，請設定 OpenClaw 以連接到手動啟動的瀏覽器：

1. 更新設定檔：

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

3. （選擇性）建立 systemd 使用者服務以自動啟動 Chrome：

ini

# ~/.config/systemd/user/openclaw-browser.service

[Unit]
Description=OpenClaw 瀏覽器 (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target

使用以下指令啟用：`systemctl --user enable --now openclaw-browser.service`

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

| 選項                     | 說明                                                        | 預設值                                         |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------- |
| `browser.enabled`        | 啟用瀏覽器控制                                              | `true`                                         |
| `browser.executablePath` | Chromium 核心瀏覽器執行檔路徑（Chrome/Brave/Edge/Chromium） | 自動偵測（偏好使用 Chromium 核心的預設瀏覽器） |
| `browser.headless`       | 無 GUI 模式執行                                             | `false`                                        |
| `browser.noSandbox`      | 新增 `--no-sandbox` 旗標（某些 Linux 環境需要）             | `false`                                        |
| `browser.attachOnly`     | 不啟動瀏覽器，只附加到已存在的瀏覽器                        | `false`                                        |
| `browser.cdpPort`        | Chrome DevTools Protocol 連接埠                             | `18800`                                        |

### 問題：「Chrome 擴充中繼正在執行，但沒有分頁已連接」

你正在使用 `chrome` 設定檔（擴充中繼）。它期望 OpenClaw 瀏覽器擴充已附加到一個活躍的分頁。

解決方案選項：

1. **使用受管理的瀏覽器：** `openclaw browser start --browser-profile openclaw`  
   （或設定 `browser.defaultProfile: "openclaw"`）。
2. **使用擴充中繼：** 安裝擴充功能，開啟一個分頁，然後點擊 OpenClaw 擴充圖示以附加。

備註：

- `chrome` 設定檔會盡可能使用你的 **系統預設 Chromium 瀏覽器**。
- 本地 `openclaw` 設定檔會自動指派 `cdpPort`/`cdpUrl`；只有遠端 CDP 需要手動設定這些。
