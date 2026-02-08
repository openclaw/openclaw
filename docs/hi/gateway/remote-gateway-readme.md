---
summary: "दूरस्थ Gateway से कनेक्ट करने के लिए OpenClaw.app हेतु SSH टनल सेटअप"
read_when: "SSH के माध्यम से macOS ऐप को दूरस्थ Gateway से कनेक्ट करते समय"
title: "Remote Gateway सेटअप"
x-i18n:
  source_path: gateway/remote-gateway-readme.md
  source_hash: b1ae266a7cb4911b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:15Z
---

# दूरस्थ Gateway के साथ OpenClaw.app चलाना

OpenClaw.app दूरस्थ Gateway से कनेक्ट करने के लिए SSH टनलिंग का उपयोग करता है। यह मार्गदर्शिका बताती है कि इसे कैसे सेटअप करें।

## अवलोकन

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

## त्वरित सेटअप

### चरण 1: SSH Config जोड़ें

`~/.ssh/config` संपादित करें और जोड़ें:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

`<REMOTE_IP>` और `<REMOTE_USER>` को अपने मानों से बदलें।

### चरण 2: SSH कुंजी कॉपी करें

अपनी सार्वजनिक कुंजी को दूरस्थ मशीन पर कॉपी करें (एक बार पासवर्ड दर्ज करें):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### चरण 3: Gateway टोकन सेट करें

```bash
launchctl setenv OPENCLAW_GATEWAY_TOKEN "<your-token>"
```

### चरण 4: SSH टनल प्रारंभ करें

```bash
ssh -N remote-gateway &
```

### चरण 5: OpenClaw.app पुनः प्रारंभ करें

```bash
# Quit OpenClaw.app (⌘Q), then reopen:
open /path/to/OpenClaw.app
```

अब ऐप SSH टनल के माध्यम से दूरस्थ Gateway से कनेक्ट होगा।

---

## लॉगिन पर टनल स्वतः प्रारंभ करें

लॉगिन करते समय SSH टनल को स्वतः प्रारंभ कराने के लिए, एक Launch Agent बनाएँ।

### PLIST फ़ाइल बनाएँ

इसे `~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist` के रूप में सहेजें:

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

### Launch Agent लोड करें

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/bot.molt.ssh-tunnel.plist
```

अब टनल यह करेगी:

- लॉगिन करते ही स्वतः प्रारंभ होगी
- क्रैश होने पर पुनः प्रारंभ होगी
- पृष्ठभूमि में चलती रहेगी

विरासत नोट: यदि मौजूद हो, तो किसी भी शेष `com.openclaw.ssh-tunnel` LaunchAgent को हटा दें।

---

## समस्या-निवारण

**जाँचें कि टनल चल रही है या नहीं:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**टनल पुनः प्रारंभ करें:**

```bash
launchctl kickstart -k gui/$UID/bot.molt.ssh-tunnel
```

**टनल रोकें:**

```bash
launchctl bootout gui/$UID/bot.molt.ssh-tunnel
```

---

## यह कैसे काम करता है

| घटक                                  | यह क्या करता है                                               |
| ------------------------------------ | ------------------------------------------------------------- |
| `LocalForward 18789 127.0.0.1:18789` | स्थानीय पोर्ट 18789 को दूरस्थ पोर्ट 18789 तक फ़ॉरवर्ड करता है |
| `ssh -N`                             | दूरस्थ कमांड निष्पादित किए बिना SSH (केवल पोर्ट फ़ॉरवर्डिंग)  |
| `KeepAlive`                          | क्रैश होने पर टनल को स्वतः पुनः प्रारंभ करता है               |
| `RunAtLoad`                          | एजेंट लोड होने पर टनल प्रारंभ करता है                         |

OpenClaw.app आपकी क्लाइंट मशीन पर `ws://127.0.0.1:18789` से कनेक्ट होता है। SSH टनल उस कनेक्शन को दूरस्थ मशीन के पोर्ट 18789 तक फ़ॉरवर्ड करती है, जहाँ Gateway चल रहा होता है।
