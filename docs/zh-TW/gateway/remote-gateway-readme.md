---
summary: "用於 OpenClaw.app 連線至遠端 Gateway 閘道器的 SSH 通道設定"
read_when: "透過 SSH 將 macOS 應用程式連線至遠端 Gateway 閘道器"
title: "遠端 Gateway 閘道器設定"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:06Z
---

# 使用遠端 Gateway 閘道器執行 OpenClaw.app

OpenClaw.app 會使用 SSH 通道連線至遠端 Gateway 閘道器。本指南將說明如何完成設定。

## 概覽

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Machine                          │
│                                                              │
│  OpenClaw.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 快速開始

### 步驟 1：新增 SSH 設定

編輯 `~/.ssh/config` 並新增：

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

將 `<REMOTE_IP>` 與 `<REMOTE_USER>` 替換為你的實際值。

### 步驟 2：複製 SSH 金鑰

將你的公開金鑰複製到遠端機器（僅需輸入一次密碼）：

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### 步驟 3：設定 Gateway 權杖

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### 步驟 4：啟動 SSH 通道

```bash
ssh -N remote-gateway &
```

### 步驟 5：重新啟動 OpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

應用程式現在會透過 SSH 通道連線至遠端 Gateway 閘道器。

---

## 登入時自動啟動通道

若要在登入時自動啟動 SSH 通道，請建立一個 Launch Agent。

### 建立 PLIST 檔案

將以下內容儲存為 `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`：

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

通道現在將會：

- 在你登入時自動啟動
- 若發生當機會自動重新啟動
- 在背景持續執行

舊版注意事項：若存在，請移除任何殘留的 `com.openclaw.ssh-tunnel` LaunchAgent。

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

## 運作方式

| 元件                                 | 功能說明                                  |
| ------------------------------------ | ----------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | 將本機連接埠 18789 轉送至遠端連接埠 18789 |
| `ssh -N`                             | SSH 不執行遠端指令（僅進行連接埠轉送）    |
| `KeepAlive`                          | 若通道當機會自動重新啟動                  |
| `RunAtLoad`                          | 在代理程式載入時啟動通道                  |

OpenClaw.app 會在你的用戶端機器上連線至 `ws://127.0.0.1:18789`。SSH 通道會將該連線轉送至遠端機器上執行中之 Gateway 閘道器的 18789 連接埠。
