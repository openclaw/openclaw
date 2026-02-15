---
summary: "針對連線至遠端 Gateway 的 OpenClaw.app 進行 SSH 通道設定"
read_when: "透過 SSH 將 macOS 應用程式連線至遠端 Gateway 時"
title: "遠端 Gateway 設定"
---

# 在遠端 Gateway 上執行 OpenClaw.app

OpenClaw.app 使用 SSH 通道連線至遠端 Gateway。本指南將向您示範如何進行設定。

## 總覽

```mermaid
flowchart TB
    subgraph Client["客戶端機器"]
        direction TB
        A["OpenClaw.app"]
        B["ws://127.0.0.1:18789\n(本地連接埠)"]
        T["SSH 通道"]

        A --> B
        B --> T
    end
    subgraph Remote["遠端機器"]
        direction TB
        C["Gateway WebSocket"]
        D["ws://127.0.0.1:18789"]

        C --> D
    end
    T --> C
```

## 快速開始

### 步驟 1：新增 SSH 設定

編輯 `~/.ssh/config` 並新增：

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # 例如：172.27.187.184
    User <REMOTE_USER>            # 例如：jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

請將 `<REMOTE_IP>` 和 `<REMOTE_USER>` 替換為您的實際數值。

### 步驟 2：複製 SSH 金鑰

將您的公鑰複製到遠端機器（需輸入一次密碼）：

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER> @<REMOTE_IP>
```

### 步驟 3：設定 Gateway Token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### 步驟 4：啟動 SSH 通道

```bash
ssh -N remote-gateway &
```

### 步驟 5：重新啟動 OpenClaw.app

```bash
# 退出 OpenClaw.app (⌘Q)，然後重新開啟：
open /path/to/OpenClaw.app
```

該應用程式現在將透過 SSH 通道連線至遠端 Gateway。

---

## 登入時自動啟動通道

若要讓 SSH 通道在您登入時自動啟動，請建立一個 Launch Agent。

### 建立 PLIST 檔案

將此內容儲存為 `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>bot.molt.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### 載入 Launch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

現在該通道將：

- 在您登入時自動啟動
- 如果當機則自動重新啟動
- 在背景持續執行

舊版本說明：若存在任何殘留的 `com.openclaw.ssh-tunnel` LaunchAgent，請將其移除。

---

## 疑難排解

**檢查通道是否正在執行：**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**重新啟動通道：**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**停止通道：**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## 運作原理

| 組件                                 | 功能說明                                  |
| ------------------------------------ | ----------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | 將本地連接埠 18789 轉發至遠端連接埠 18789 |
| `ssh -N`                             | 不執行遠端指令的 SSH（僅進行連接埠轉發）  |
| `KeepAlive`                          | 如果通道當機，則自動重新啟動              |
| `RunAtLoad`                          | 在代理載入時啟動通道                      |

OpenClaw.app 會連線至您客戶端機器上的 `ws://127.0.0.1:18789`。SSH 通道會將該連線轉發至執行 Gateway 的遠端機器上的連接埠 18789。
