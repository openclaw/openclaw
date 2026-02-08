---
summary: "ریموٹ گیٹ وے سے کنکشن کے لیے OpenClaw.app کی SSH سرنگ سیٹ اپ"
read_when: "SSH کے ذریعے macOS ایپ کو ریموٹ گیٹ وے سے جوڑتے وقت"
title: "ریموٹ Gateway سیٹ اپ"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:15Z
---

# ریموٹ Gateway کے ساتھ OpenClaw.app چلانا

OpenClaw.app ریموٹ گیٹ وے سے جڑنے کے لیے SSH ٹنلنگ استعمال کرتا ہے۔ یہ رہنما آپ کو اس کی سیٹ اپ کا طریقہ دکھاتا ہے۔

## جائزہ

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

## فوری سیٹ اپ

### مرحلہ 1: SSH کنفیگ شامل کریں

`~/.ssh/config` میں ترمیم کریں اور شامل کریں:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` اور `<REMOTE_USER>` کو اپنی قدروں سے بدل دیں۔

### مرحلہ 2: SSH کلید کاپی کریں

اپنی پبلک کلید ریموٹ مشین پر کاپی کریں (ایک بار پاس ورڈ درج کریں):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### مرحلہ 3: Gateway ٹوکن سیٹ کریں

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### مرحلہ 4: SSH سرنگ شروع کریں

```bash
ssh -N remote-gateway &
```

### مرحلہ 5: OpenClaw.app دوبارہ شروع کریں

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

اب ایپ SSH سرنگ کے ذریعے ریموٹ گیٹ وے سے جڑ جائے گی۔

---

## لاگ اِن پر سرنگ کو خودکار طور پر شروع کریں

لاگ اِن کرتے ہی SSH سرنگ خود بخود شروع کرنے کے لیے ایک Launch Agent بنائیں۔

### PLIST فائل بنائیں

اسے `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` کے طور پر محفوظ کریں:

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

### Launch Agent لوڈ کریں

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

اب سرنگ یہ کرے گی:

- لاگ اِن پر خود بخود شروع ہوگی
- اگر کریش ہو جائے تو دوبارہ شروع ہوگی
- پس منظر میں چلتی رہے گی

لیگیسی نوٹ: اگر موجود ہو تو کسی بھی باقی ماندہ `com.openclaw.ssh-tunnel` LaunchAgent کو ہٹا دیں۔

---

## خرابیوں کا ازالہ

**چیک کریں کہ سرنگ چل رہی ہے یا نہیں:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**سرنگ دوبارہ شروع کریں:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**سرنگ بند کریں:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## یہ کیسے کام کرتا ہے

| جزو                                  | یہ کیا کرتا ہے                                            |
| ------------------------------------ | --------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | لوکل پورٹ 18789 کو ریموٹ پورٹ 18789 کی طرف فارورڈ کرتا ہے |
| `ssh -N`                             | ریموٹ کمانڈز چلائے بغیر SSH (صرف پورٹ فارورڈنگ)           |
| `KeepAlive`                          | کریش ہونے پر سرنگ کو خود بخود دوبارہ شروع کرتا ہے         |
| `RunAtLoad`                          | ایجنٹ لوڈ ہونے پر سرنگ شروع کرتا ہے                       |

OpenClaw.app آپ کی کلائنٹ مشین پر `ws://127.0.0.1:18789` سے جڑتا ہے۔ SSH سرنگ اس کنکشن کو ریموٹ مشین کے پورٹ 18789 تک فارورڈ کرتی ہے جہاں Gateway چل رہا ہوتا ہے۔
