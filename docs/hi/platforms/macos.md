---
summary: "OpenClaw macOS सहचर ऐप (मेनू बार + Gateway ब्रोकर)"
read_when:
  - macOS ऐप फीचर्स को लागू करते समय
  - macOS पर Gateway लाइफसाइकिल या नोड ब्रिजिंग में परिवर्तन करते समय
title: "macOS ऐप"
---

# OpenClaw macOS सहचर (मेनू बार + Gateway ब्रोकर)

The macOS app is the **menu‑bar companion** for OpenClaw. It owns permissions,
manages/attaches to the Gateway locally (launchd or manual), and exposes macOS
capabilities to the agent as a node.

## यह क्या करता है

- मेनू बार में मूल (नेटिव) सूचनाएँ और स्थिति दिखाता है।
- TCC प्रॉम्प्ट्स का स्वामित्व लेता है (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript)।
- Gateway को चलाता है या उससे कनेक्ट करता है (स्थानीय या दूरस्थ)।
- केवल macOS‑विशिष्ट टूल्स को एक्सपोज़ करता है (Canvas, Camera, Screen Recording, `system.run`)।
- **Remote** मोड में स्थानीय नोड होस्ट सेवा शुरू करता है (launchd), और **Local** मोड में उसे रोकता है।
- UI ऑटोमेशन के लिए वैकल्पिक रूप से **PeekabooBridge** होस्ट करता है।
- अनुरोध पर npm/pnpm के माध्यम से वैश्विक CLI (`openclaw`) इंस्टॉल करता है (Gateway रनटाइम के लिए bun की सिफारिश नहीं की जाती)।

## Local बनाम Remote मोड

- **Local** (डिफ़ॉल्ट): यदि चल रहा स्थानीय Gateway मौजूद है तो ऐप उससे अटैच होता है;
  अन्यथा यह `openclaw gateway install` के माध्यम से launchd सेवा सक्षम करता है।
- **Remote**: the app connects to a Gateway over SSH/Tailscale and never starts
  a local process.
  The app starts the local **node host service** so the remote Gateway can reach this Mac.
  The app does not spawn the Gateway as a child process.

## Launchd नियंत्रण

The app manages a per‑user LaunchAgent labeled `bot.molt.gateway`
(or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` still unloads).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Replace the label with `bot.molt.<profile>` when running a named profile.

यदि LaunchAgent इंस्टॉल नहीं है, तो ऐप से इसे सक्षम करें या
`openclaw gateway install` चलाएँ।

## नोड क्षमताएँ (mac)

The macOS app presents itself as a node. सामान्य कमांड:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

नोड एक `permissions` मैप रिपोर्ट करता है ताकि एजेंट तय कर सकें कि क्या अनुमति है।

Node सेवा + ऐप IPC:

- जब हेडलेस node host सेवा चल रही होती है (remote मोड), यह Gateway WS से एक नोड के रूप में कनेक्ट होती है।
- `system.run` macOS ऐप (UI/TCC संदर्भ) में एक स्थानीय Unix सॉकेट के माध्यम से निष्पादित होता है; प्रॉम्प्ट्स + आउटपुट ऐप के भीतर ही रहते हैं।

आरेख (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec अनुमोदन (system.run)

`system.run` is controlled by **Exec approvals** in the macOS app (Settings → Exec approvals).
Security + ask + allowlist are stored locally on the Mac in:

```
~/.openclaw/exec-approvals.json
```

उदाहरण:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

नोट्स:

- `allowlist` प्रविष्टियाँ रेज़ॉल्व्ड बाइनरी पाथ्स के लिए glob पैटर्न हैं।
- प्रॉम्प्ट में “Always Allow” चुनने से वह कमांड allowlist में जोड़ दी जाती है।
- `system.run` पर्यावरण ओवरराइड्स फ़िल्टर किए जाते हैं (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT` हटाए जाते हैं) और फिर ऐप के पर्यावरण के साथ मर्ज किए जाते हैं।

## Deep links

ऐप स्थानीय कार्रवाइयों के लिए `openclaw://` URL स्कीम पंजीकृत करता है।

### `openclaw://agent`

Gateway `agent` अनुरोध को ट्रिगर करता है।

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

क्वेरी पैरामीटर:

- `message` (आवश्यक)
- `sessionKey` (वैकल्पिक)
- `thinking` (वैकल्पिक)
- `deliver` / `to` / `channel` (वैकल्पिक)
- `timeoutSeconds` (वैकल्पिक)
- `key` (वैकल्पिक unattended मोड कुंजी)

सुरक्षा:

- `key` के बिना, ऐप पुष्टि के लिए प्रॉम्प्ट करता है।
- मान्य `key` के साथ, रन unattended होता है (व्यक्तिगत ऑटोमेशन के लिए अभिप्रेत)।

## ऑनबोर्डिंग प्रवाह (सामान्य)

1. **OpenClaw.app** इंस्टॉल करें और लॉन्च करें।
2. अनुमतियों की चेकलिस्ट पूरी करें (TCC प्रॉम्प्ट्स)।
3. सुनिश्चित करें कि **Local** मोड सक्रिय है और Gateway चल रहा है।
4. यदि आप टर्मिनल एक्सेस चाहते हैं तो CLI इंस्टॉल करें।

## Build & dev वर्कफ़्लो (नेटिव)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (या Xcode)
- ऐप पैकेज करें: `scripts/package-mac-app.sh`

## Gateway कनेक्टिविटी डिबग करें (macOS CLI)

डिबग CLI का उपयोग करके वही Gateway WebSocket हैंडशेक और डिस्कवरी
लॉजिक आज़माएँ जो macOS ऐप उपयोग करता है, बिना ऐप लॉन्च किए।

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

कनेक्ट विकल्प:

- `--url <ws://host:port>`: विन्यास ओवरराइड करें
- `--mode <local|remote>`: विन्यास से रेज़ॉल्व करें (डिफ़ॉल्ट: config या local)
- `--probe`: नया health probe मजबूर करें
- `--timeout <ms>`: अनुरोध टाइमआउट (डिफ़ॉल्ट: `15000`)
- `--json`: diffing के लिए संरचित आउटपुट

डिस्कवरी विकल्प:

- `--include-local`: उन gateways को शामिल करें जिन्हें “local” के रूप में फ़िल्टर किया जाता
- `--timeout <ms>`: समग्र डिस्कवरी विंडो (डिफ़ॉल्ट: `2000`)
- `--json`: diffing के लिए संरचित आउटपुट

सुझाव: `openclaw gateway discover --json` के विरुद्ध तुलना करें ताकि यह देखा जा सके कि
macOS ऐप की डिस्कवरी पाइपलाइन (NWBrowser + tailnet DNS‑SD fallback)
Node CLI की `dns-sd` आधारित डिस्कवरी से भिन्न है या नहीं।

## Remote कनेक्शन प्लंबिंग (SSH टनल)

जब macOS ऐप **Remote** मोड में चलता है, तो यह एक SSH टनल खोलता है ताकि स्थानीय UI
घटक दूरस्थ Gateway से ऐसे बात कर सकें मानो वह localhost पर हो।

### Control टनल (Gateway WebSocket पोर्ट)

- **उद्देश्य:** health checks, स्थिति, Web Chat, config, और अन्य control‑plane कॉल्स।
- **स्थानीय पोर्ट:** Gateway पोर्ट (डिफ़ॉल्ट `18789`), हमेशा स्थिर।
- **दूरस्थ पोर्ट:** दूरस्थ होस्ट पर वही Gateway पोर्ट।
- **व्यवहार:** कोई रैंडम स्थानीय पोर्ट नहीं; ऐप मौजूदा स्वस्थ टनल का पुन: उपयोग करता है
  या आवश्यकता होने पर उसे पुनः शुरू करता है।
- **SSH स्वरूप:** `ssh -N -L <local>:127.0.0.1:<remote>` BatchMode +
  ExitOnForwardFailure + keepalive विकल्पों के साथ।
- **IP reporting:** the SSH tunnel uses loopback, so the gateway will see the node
  IP as `127.0.0.1`. Use **Direct (ws/wss)** transport if you want the real client
  IP to appear (see [macOS remote access](/platforms/mac/remote)).

For setup steps, see [macOS remote access](/platforms/mac/remote). For protocol
details, see [Gateway protocol](/gateway/protocol).

## संबंधित दस्तावेज़

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
