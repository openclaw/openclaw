---
summary: "macOS पर Gateway रनटाइम (बाहरी launchd सेवा)"
read_when:
  - OpenClaw.app पैकेज करना
  - macOS Gateway launchd सेवा का डिबग करना
  - macOS के लिए Gateway CLI स्थापित करना
title: "macOS पर Gateway"
x-i18n:
  source_path: platforms/mac/bundled-gateway.md
  source_hash: 4a3e963d13060b12
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:28Z
---

# macOS पर Gateway (बाहरी launchd)

OpenClaw.app अब Node/Bun या Gateway रनटाइम को बंडल नहीं करता। macOS ऐप एक **बाहरी** `openclaw` CLI इंस्टॉलेशन की अपेक्षा करता है, Gateway को चाइल्ड प्रोसेस के रूप में प्रारंभ नहीं करता, और Gateway को चालू रखने के लिए प्रति‑उपयोगकर्ता launchd सेवा का प्रबंधन करता है (या यदि पहले से कोई स्थानीय Gateway चल रहा हो तो उससे जुड़ जाता है)।

## CLI इंस्टॉल करें (स्थानीय मोड के लिए आवश्यक)

Mac पर आपको Node 22+ चाहिए, फिर `openclaw` को वैश्विक रूप से इंस्टॉल करें:

```bash
npm install -g openclaw@<version>
```

macOS ऐप का **Install CLI** बटन npm/pnpm के माध्यम से वही प्रक्रिया चलाता है (Gateway रनटाइम के लिए bun अनुशंसित नहीं है)।

## Launchd (LaunchAgent के रूप में Gateway)

लेबल:

- `bot.molt.gateway` (या `bot.molt.<profile>`; लेगेसी `com.openclaw.*` बना रह सकता है)

Plist स्थान (प्रति‑उपयोगकर्ता):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (या `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

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

macOS ऐप Gateway संस्करण की तुलना अपने संस्करण से करता है। यदि वे असंगत हों, तो ऐप संस्करण से मेल कराने के लिए वैश्विक CLI को अपडेट करें।

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
