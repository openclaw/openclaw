---
summary: "การตั้งค่าอุโมงค์SSHสำหรับOpenClaw.appเพื่อเชื่อมต่อกับเกตเวย์ระยะไกล"
read_when: "การเชื่อมต่อแอปmacOSกับเกตเวย์ระยะไกลผ่านSSH"
title: "การตั้งค่าRemote Gateway"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:52:10Z
---

# การรันOpenClaw.appด้วยRemote Gateway

OpenClaw.appใช้อุโมงค์SSHเพื่อเชื่อมต่อกับเกตเวย์ระยะไกล คู่มือนี้จะแสดงวิธีการตั้งค่า

## ภาพรวม

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

## การตั้งค่าอย่างรวดเร็ว

### ขั้นตอนที่1: เพิ่มคอนฟิกSSH

แก้ไข`~/.ssh/config`และเพิ่ม:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

แทนที่`<REMOTE_IP>`และ`<REMOTE_USER>`ด้วยค่าของคุณ

### ขั้นตอนที่2: คัดลอกคีย์SSH

คัดลอกคีย์สาธารณะของคุณไปยังเครื่องระยะไกล(ป้อนรหัสผ่านเพียงครั้งเดียว):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### ขั้นตอนที่3: ตั้งค่าGateway Token

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### ขั้นตอนที่4: เริ่มอุโมงค์SSH

```bash
ssh -N remote-gateway &
```

### ขั้นตอนที่5: รีสตาร์ทOpenClaw.app

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

แอปจะเชื่อมต่อกับเกตเวย์ระยะไกลผ่านอุโมงค์SSHแล้ว

---

## การเริ่มอุโมงค์อัตโนมัติเมื่อเข้าสู่ระบบ

หากต้องการให้อุโมงค์SSHเริ่มทำงานอัตโนมัติเมื่อคุณล็อกอิน ให้สร้างLaunch Agent

### สร้างไฟล์PLIST

บันทึกไฟล์นี้เป็น`~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist`:

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

### โหลดLaunch Agent

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

อุโมงค์จะทำงานดังนี้:

- เริ่มทำงานอัตโนมัติเมื่อคุณล็อกอิน
- รีสตาร์ทหากเกิดการขัดข้อง
- ทำงานต่อเนื่องในพื้นหลัง

หมายเหตุสำหรับระบบเดิม: หากมีLaunchAgentของ`com.openclaw.ssh-tunnel`คงค้างอยู่ ให้ลบออก

---

## การแก้ไขปัญหา

**ตรวจสอบว่าอุโมงค์กำลังทำงานอยู่หรือไม่:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**รีสตาร์ทอุโมงค์:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**หยุดอุโมงค์:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## ทำงานอย่างไร

| องค์ประกอบ                           | ทำอะไรบ้าง                                                  |
| ------------------------------------ | ----------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | ส่งต่อพอร์ตภายในเครื่อง18789ไปยังพอร์ต18789บนเครื่องระยะไกล |
| `ssh -N`                             | ใช้SSHโดยไม่รันคำสั่งบนเครื่องระยะไกล(เฉพาะการส่งต่อพอร์ต)  |
| `KeepAlive`                          | รีสตาร์ทอุโมงค์โดยอัตโนมัติหากเกิดการขัดข้อง                |
| `RunAtLoad`                          | เริ่มอุโมงค์เมื่อเอเจนต์ถูกโหลด                             |

OpenClaw.appเชื่อมต่อไปยัง`ws://127.0.0.1:18789`บนเครื่องไคลเอนต์ของคุณ จากนั้นอุโมงค์SSHจะส่งต่อการเชื่อมต่อนั้นไปยังพอร์ต18789บนเครื่องระยะไกลที่Gatewayกำลังทำงานอยู่
