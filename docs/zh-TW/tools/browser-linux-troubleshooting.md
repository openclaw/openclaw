---
summary: "修正 Linux 上 Chrome/Brave/Edge/Chromium CDP 啟動 OpenClaw 瀏覽器控制問題"
read_when: "Linux 上瀏覽器控制失敗，尤其是在使用 snap Chromium 時"
title: "瀏覽器疑難排解"
---

# 瀏覽器疑難排解 (Linux)

## 問題：「無法在連接埠 18800 啟動 Chrome CDP」

OpenClaw 的瀏覽器控制伺服器無法啟動 Chrome/Brave/Edge/Chromium，並出現錯誤：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

在 Ubuntu (以及許多 Linux 發行版) 上，預設的 Chromium 安裝是透過 **snap 封裝**。Snap 的 AppArmor 限制會干擾 OpenClaw 產生和監控瀏覽器程式的方式。

`apt install chromium` 指令會安裝一個轉址到 snap 的存根封裝：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

這並不是一個真正的瀏覽器 — 它只是一個包裝器。

### 解決方案 1：安裝 Google Chrome（建議）

安裝官方的 Google Chrome `.deb` 檔案，它不受 snap 沙箱隔離：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 如果有依賴錯誤
```

然後更新您的 OpenClaw 設定 (`~/.openclaw/openclaw.json`)：

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

### 解決方案 2：使用 Snap Chromium 搭配僅附加模式

如果您必須使用 snap Chromium，請設定 OpenClaw 附加到手動啟動的瀏覽器：

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

3. 選擇性地建立 systemd 使用者服務以自動啟動 Chrome：

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

| 選項                       
