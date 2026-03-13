---
summary: SSH tunnel setup for OpenClaw.app connecting to a remote gateway
read_when: Connecting the macOS app to a remote gateway over SSH
title: Remote Gateway Setup
---

# 使用遠端閘道執行 OpenClaw.app

OpenClaw.app 使用 SSH 隧道連接到遠端閘道。此指南將指導您如何設置它。

## 概述

mermaid
flowchart TB
subgraph Client["用戶端機器"]
direction TB
A["OpenClaw.app"]
B["ws://127.0.0.1:18789\n(本地端口)"]
T["SSH 隧道"]

A --> B  
 B --> T  
 end  
 subgraph Remote["遠端機器"]  
 direction TB  
 C["閘道 WebSocket"]  
 D["ws://127.0.0.1:18789"]

C --> D
end
T --> C

## 快速設置

### 步驟 1：新增 SSH 設定

`~/.ssh/config`

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

將 `<REMOTE_IP>` 和 `<REMOTE_USER>` 替換為您的值。

### 步驟 2：複製 SSH 金鑰

將您的公鑰複製到遠端機器（輸入密碼一次）：

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### 步驟 3：設定閘道token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### 步驟 4：啟動 SSH 隧道

```bash
ssh -N remote-gateway &
```

### 步驟 5：重新啟動 OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

應用程式現在將通過 SSH 隧道連接到遠端閘道。

---

## 自動啟動隧道於登入時

要在登入時自動啟動 SSH 隧道，請建立一個啟動代理。

### 建立 PLIST 檔案

`~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.ssh-tunnel</string>
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

### 載入啟動代理

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.ssh-tunnel.plist
```

[[BLOCK_1]]  
隧道現在將：  
[[BLOCK_1]]

- 登入時自動啟動
- 如果崩潰則重新啟動
- 在背景持續執行

Legacy note: 移除任何剩餘的 `com.openclaw.ssh-tunnel` LaunchAgent（如果存在）。

---

## 故障排除

**檢查隧道是否正在執行：**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**重新啟動隧道：**

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.ssh-tunnel
```

**停止隧道：**

```bash
launchctl bootout gui/$UID/ai.openclaw.ssh-tunnel
```

---

## 如何運作

| 元件                                 | 功能                                  |
| ------------------------------------ | ------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | 將本地端口 18789 轉發到遠端端口 18789 |
| `ssh -N`                             | SSH 不執行遠端命令（僅進行端口轉發）  |
| `KeepAlive`                          | 如果隧道崩潰，自動重啟隧道            |
| `RunAtLoad`                          | 當代理載入時啟動隧道                  |

OpenClaw.app 會在您的用戶端機器上連接到 `ws://127.0.0.1:18789`。SSH 隧道將該連接轉發到遠端機器上的 18789 埠，該機器執行著 Gateway。
