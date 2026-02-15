---
summary: "修復 Linux 上 OpenClaw 瀏覽器控制的 Chrome/Brave/Edge/Chromium CDP 啟動問題"
read_when: "在 Linux 上瀏覽器控制失敗時，特別是使用 snap 版 Chromium 時"
title: "瀏覽器疑難排解"
---

# 瀏覽器疑難排解 (Linux)

## 問題：「無法在連接埠 18800 啟動 Chrome CDP」

OpenClaw 的瀏覽器控制伺服器無法啟動 Chrome/Brave/Edge/Chromium，錯誤訊息如下：

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### 根本原因

在 Ubuntu（以及許多 Linux 發行版）上，預設的 Chromium 安裝是 **snap 套件**。Snap 的 AppArmor 限制會干擾 OpenClaw 啟動和監控瀏覽器程序的方式。

`apt install chromium` 命令會安裝一個重新導向至 snap 的虛擬套件：

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

這不是真正的瀏覽器 — 它只是一個包裝器 (wrapper)。

### 解決方案 1：安裝 Google Chrome（推薦）

安裝官方的 Google Chrome `.deb` 套件，它不受 snap 沙箱隔離限制：

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # 如果有相依性錯誤
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

### 解決方案 2：使用 Snap 版 Chromium 並搭配 Attach-Only 模式

如果你必須使用 snap 版 Chromium，請將 OpenClaw 設定為連接到手動啟動的瀏覽器：

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

3. （選用）建立一個 systemd 使用者服務來自動啟動 Chrome：

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

使用以下命令啟用：`systemctl --user enable --now openclaw-browser.service`

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

| 選項 | 描述 | 預設值 |
| ---- | ---- | ------ |
