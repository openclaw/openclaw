---
summary: "Linux पर OpenClaw ब्राउज़र नियंत्रण के लिए Chrome/Brave/Edge/Chromium CDP स्टार्टअप समस्याएँ ठीक करें"
read_when: "Linux पर ब्राउज़र नियंत्रण विफल हो, विशेषकर snap Chromium के साथ"
title: "ब्राउज़र समस्या-निवारण"
---

# ब्राउज़र समस्या-निवारण (Linux)

## समस्या: "Failed to start Chrome CDP on port 18800"

OpenClaw का ब्राउज़र नियंत्रण सर्वर निम्न त्रुटि के साथ Chrome/Brave/Edge/Chromium को लॉन्च करने में विफल रहता है:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### मूल कारण

On Ubuntu (and many Linux distros), the default Chromium installation is a **snap package**. Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors the browser process.

`apt install chromium` कमांड एक stub पैकेज स्थापित करता है जो snap की ओर रीडायरेक्ट करता है:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

यह कोई वास्तविक ब्राउज़र नहीं है — यह केवल एक रैपर है।

### समाधान 1: Google Chrome इंस्टॉल करें (अनुशंसित)

आधिकारिक Google Chrome `.deb` पैकेज इंस्टॉल करें, जो snap द्वारा sandboxed नहीं होता है:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

फिर अपना OpenClaw विन्यास अपडेट करें (`~/.openclaw/openclaw.json`):

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

### समाधान 2: Attach-Only मोड के साथ Snap Chromium का उपयोग करें

यदि आपको snap Chromium का उपयोग करना ही है, तो OpenClaw को मैन्युअली-स्टार्ट किए गए ब्राउज़र से अटैच करने के लिए कॉन्फ़िगर करें:

1. विन्यास अपडेट करें:

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

2. Chromium को मैन्युअली शुरू करें:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. वैकल्पिक रूप से Chrome को ऑटो-स्टार्ट करने के लिए एक systemd user service बनाएँ:

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

इनेबल करें: `systemctl --user enable --now openclaw-browser.service`

### यह सत्यापित करना कि ब्राउज़र काम करता है

स्थिति जाँचें:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

ब्राउज़िंग का परीक्षण करें:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### विन्यास संदर्भ

| विकल्प                   | विवरण                                                                                 | डिफ़ॉल्ट                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `browser.enabled`        | ब्राउज़र नियंत्रण सक्षम करें                                                          | `true`                                                                                     |
| `browser.executablePath` | Chromium-आधारित ब्राउज़र बाइनरी का पथ (Chrome/Brave/Edge/Chromium) | auto-detected (Chromium-आधारित होने पर डिफ़ॉल्ट ब्राउज़र को प्राथमिकता) |
| `browser.headless`       | GUI के बिना चलाएँ                                                                     | `false`                                                                                    |
| `browser.noSandbox`      | `--no-sandbox` फ़्लैग जोड़ें (कुछ Linux सेटअप के लिए आवश्यक)       | `false`                                                                                    |
| `browser.attachOnly`     | ब्राउज़र लॉन्च न करें, केवल मौजूदा से अटैच करें                                       | `false`                                                                                    |
| `browser.cdpPort`        | Chrome DevTools Protocol पोर्ट                                                        | `18800`                                                                                    |

### समस्या: "Chrome extension relay is running, but no tab is connected"

You’re using the `chrome` profile (extension relay). It expects the OpenClaw
browser extension to be attached to a live tab.

समाधान विकल्प:

1. **Managed browser का उपयोग करें:** `openclaw browser start --browser-profile openclaw`
   (या `browser.defaultProfile: "openclaw"` सेट करें)।
2. **Extension relay का उपयोग करें:** एक्सटेंशन इंस्टॉल करें, एक टैब खोलें, और
   OpenClaw एक्सटेंशन आइकन पर क्लिक करके उसे अटैच करें।

नोट्स:

- `chrome` प्रोफ़ाइल संभव होने पर आपके **सिस्टम डिफ़ॉल्ट Chromium ब्राउज़र** का उपयोग करती है।
- Local `openclaw` प्रोफ़ाइल्स `cdpPort`/`cdpUrl` को स्वतः असाइन करती हैं; उन्हें केवल remote CDP के लिए सेट करें।
