---
summary: "macOS पर Gateway रनटाइम (बाहरी launchd सेवा)"
read_when:
  - OpenClaw.app पैकेज करना
  - macOS Gateway launchd सेवा का डिबग करना
  - macOS के लिए Gateway CLI स्थापित करना
title: "macOS पर Gateway"
---

# macOS पर Gateway (बाहरी launchd)

OpenClaw.app no longer bundles Node/Bun or the Gateway runtime. The macOS app
expects an **external** `openclaw` CLI install, does not spawn the Gateway as a
child process, and manages a per‑user launchd service to keep the Gateway
running (or attaches to an existing local Gateway if one is already running).

## CLI इंस्टॉल करें (स्थानीय मोड के लिए आवश्यक)

Mac पर आपको Node 22+ चाहिए, फिर `openclaw` को वैश्विक रूप से इंस्टॉल करें:

```bash
npm install -g openclaw@<version>
```

macOS ऐप का **Install CLI** बटन npm/pnpm के माध्यम से वही प्रक्रिया चलाता है (Gateway रनटाइम के लिए bun अनुशंसित नहीं है)।

## Launchd (LaunchAgent के रूप में Gateway)

लेबल:

- `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.openclaw.*` may remain)

Plist स्थान (प्रति‑उपयोगकर्ता):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (or `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

प्रबंधक:

- स्थानीय मोड में LaunchAgent की इंस्टॉल/अपडेट का स्वामित्व macOS ऐप के पास होता है।
- CLI भी इसे इंस्टॉल कर सकता है: `openclaw gateway install`।

व्यवहार:

- “OpenClaw Active” LaunchAgent को सक्षम/अक्षम करता है।
- ऐप से बाहर निकलने पर Gateway **बंद नहीं** होता (launchd इसे सक्रिय रखता है)।
- यदि कॉन्फ़िगर किए गए पोर्ट पर पहले से कोई Gateway चल रहा है, तो ऐप नया शुरू करने के बजाय उससे जुड़ जाता है।

लॉगिंग:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## संस्करण संगतता

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## स्मोक चेक

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

फिर:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
