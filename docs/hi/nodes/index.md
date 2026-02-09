---
summary: "नोड्स: पेयरिंग, क्षमताएँ, अनुमतियाँ, और canvas/camera/screen/system के लिए CLI हेल्पर्स"
read_when:
  - iOS/Android नोड्स को Gateway से पेयर करना
  - एजेंट संदर्भ के लिए नोड canvas/camera का उपयोग
  - नए नोड कमांड या CLI हेल्पर्स जोड़ना
title: "नोड्स"
---

# नोड्स

Nodes **peripherals** होते हैं, gateways नहीं। वे gateway service नहीं चलाते।

लीगेसी ट्रांसपोर्ट: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; अप्रचलित/वर्तमान नोड्स के लिए हटाया गया)।

macOS **node mode** में भी चल सकता है: मेन्यूबार ऐप Gateway के WS सर्वर से कनेक्ट होता है और अपने स्थानीय canvas/camera कमांड्स को एक नोड के रूप में एक्सपोज़ करता है (ताकि `openclaw nodes …` इस Mac के विरुद्ध काम करे)।

नोट्स:

- **WS nodes device pairing का उपयोग करते हैं।** Nodes `connect` के दौरान एक device identity प्रस्तुत करते हैं; Gateway `role: node` के लिए एक device pairing request बनाता है। devices CLI (या UI) के माध्यम से approve करें।
- Telegram/WhatsApp आदि संदेश **gateway** पर आते हैं, नोड्स पर नहीं।
- समस्या-निवारण रनबुक: [/nodes/troubleshooting](/nodes/troubleshooting)

## पेयरिंग + स्थिति

जब आपका Gateway एक मशीन पर चलता हो और आप चाहते हों कि कमांड्स किसी दूसरी मशीन पर execute हों, तब **node host** का उपयोग करें। Approve via the devices CLI (or UI).

त्वरित CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

नोट्स:

- `nodes status` किसी नोड को **paired** के रूप में चिह्नित करता है जब उसकी डिवाइस पेयरिंग भूमिका में `node` शामिल हो।
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) एक अलग gateway-स्वामित्व वाला
  नोड पेयरिंग स्टोर है; यह WS `connect` हैंडशेक को **गेट** नहीं करता।

## रिमोट नोड होस्ट (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands
to execute on another. यदि Gateway लूपबैक से बाइंड करता है (`gateway.bind=loopback`, लोकल मोड में डिफ़ॉल्ट), तो रिमोट node hosts सीधे कनेक्ट नहीं कर सकते।

### क्या कहाँ चलता है

- **Gateway होस्ट**: संदेश प्राप्त करता है, मॉडल चलाता है, टूल कॉल्स रूट करता है।
- **Node host**: नोड मशीन पर `system.run`/`system.which` निष्पादित करता है।
- **Approvals**: `~/.openclaw/exec-approvals.json` के माध्यम से node host पर लागू होते हैं।

### नोड होस्ट शुरू करें (foreground)

नोड मशीन पर:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH टनल के माध्यम से रिमोट gateway (loopback bind)

एक SSH टनल बनाएँ और node host को टनल के लोकल सिरे की ओर पॉइंट करें। Exec अनुमोदन **प्रति node host** होते हैं।

उदाहरण (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

नोट्स:

- टोकन gateway config से `gateway.auth.token` है (gateway होस्ट पर `~/.openclaw/openclaw.json`)।
- `openclaw node run` प्रमाणीकरण के लिए `OPENCLAW_GATEWAY_TOKEN` पढ़ता है।

### नोड होस्ट शुरू करें (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### पेयर + नाम

gateway होस्ट पर:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

नामकरण विकल्प:

- `openclaw node run` / `openclaw node install` पर `--display-name` (नोड पर `~/.openclaw/node.json` में स्थायी रहता है)।
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway ओवरराइड)।

### कमांड्स को allowlist करें

gateway से allowlist एंट्रीज़ जोड़ें: Nodes `screen.record` (mp4) एक्सपोज़ करते हैं।

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals node host पर `~/.openclaw/exec-approvals.json` में रहती हैं।

### exec को नोड की ओर इंगित करें

डिफ़ॉल्ट्स कॉन्फ़िगर करें (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

या प्रति सत्र:

```
/exec host=node security=allowlist node=<id-or-name>
```

एक बार सेट होने पर, किसी भी `exec` कॉल में `host=node` के साथ निष्पादन node host पर होता है (node allowlist/approvals के अधीन)।

संबंधित:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## कमांड्स का आह्वान

लो-लेवल (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

सामान्य “एजेंट को MEDIA अटैचमेंट देना” वर्कफ़्लो के लिए उच्च-स्तरीय हेल्पर्स उपलब्ध हैं।

## स्क्रीनशॉट्स (canvas snapshots)

यदि नोड Canvas (WebView) दिखा रहा है, तो `canvas.snapshot` `{ format, base64 }` लौटाता है।

CLI हेल्पर (एक temp फ़ाइल में लिखता है और `MEDIA:<path>` प्रिंट करता है):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas नियंत्रण

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

नोट्स:

- `canvas present` URLs या लोकल फ़ाइल पाथ्स (`--target`) स्वीकार करता है, साथ ही पोज़िशनिंग के लिए वैकल्पिक `--x/--y/--width/--height`।
- `canvas eval` inline JS (`--js`) या एक positional arg स्वीकार करता है।

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

नोट्स:

- केवल A2UI v0.8 JSONL समर्थित है (v0.9/createSurface अस्वीकार किया जाता है)।

## फ़ोटो + वीडियो (नोड कैमरा)

फ़ोटो (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

वीडियो क्लिप्स (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

नोट्स:

- `canvas.*` और `camera.*` के लिए नोड का **foregrounded** होना आवश्यक है (background कॉल्स `NODE_BACKGROUND_UNAVAILABLE` लौटाते हैं)।
- बेस64 payloads के अत्यधिक बड़े होने से बचाने के लिए क्लिप अवधि सीमित है (वर्तमान में `<= 60s`)।
- Android जहाँ संभव हो `CAMERA`/`RECORD_AUDIO` अनुमतियों के लिए प्रॉम्प्ट करेगा; अस्वीकृत अनुमतियाँ `*_PERMISSION_REQUIRED` के साथ विफल होंगी।

## स्क्रीन रिकॉर्डिंग्स (नोड्स)

macOS node `system.run`, `system.notify`, और `system.execApprovals.get/set` एक्सपोज़ करता है। उदाहरण:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

नोट्स:

- `screen.record` के लिए नोड ऐप का foregrounded होना आवश्यक है।
- Android रिकॉर्डिंग से पहले सिस्टम स्क्रीन-कैप्चर प्रॉम्प्ट दिखाएगा।
- स्क्रीन रिकॉर्डिंग्स `<= 60s` तक सीमित होती हैं।
- `--no-audio` माइक्रोफ़ोन कैप्चर को अक्षम करता है (iOS/Android पर समर्थित; macOS सिस्टम कैप्चर ऑडियो का उपयोग करता है)।
- कई स्क्रीन उपलब्ध होने पर डिस्प्ले चुनने के लिए `--screen <index>` का उपयोग करें।

## लोकेशन (नोड्स)

सेटिंग्स में Location सक्षम होने पर नोड्स `location.get` एक्सपोज़ करते हैं।

CLI हेल्पर:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

नोट्स:

- Location **डिफ़ॉल्ट रूप से बंद** रहती है।
- “Always” के लिए सिस्टम अनुमति आवश्यक है; background fetch best-effort होता है।
- प्रतिक्रिया में lat/lon, accuracy (मीटर), और timestamp शामिल होते हैं।

## SMS (Android नोड्स)

Android नोड्स तब `sms.send` एक्सपोज़ कर सकते हैं जब उपयोगकर्ता **SMS** अनुमति देता है और डिवाइस टेलीफ़ोनी का समर्थन करता है।

लो-लेवल invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

नोट्स:

- क्षमता विज्ञापित होने से पहले Android डिवाइस पर अनुमति प्रॉम्प्ट स्वीकार करना आवश्यक है।
- टेलीफ़ोनी के बिना Wi‑Fi‑only डिवाइस `sms.send` विज्ञापित नहीं करेंगे।

## सिस्टम कमांड्स (node host / mac node)

headless node host `system.run`, `system.which`, और `system.execApprovals.get/set` एक्सपोज़ करता है।
macOS node मोड में, `system.run` macOS ऐप में exec approvals द्वारा नियंत्रित होता है (Settings → Exec approvals)।

उदाहरण:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

नोट्स:

- `system.run` payload में stdout/stderr/exit code लौटाता है।
- `system.notify` macOS ऐप में notification permission स्थिति का सम्मान करता है।
- `system.run` `--cwd`, `--env KEY=VAL`, `--command-timeout`, और `--needs-screen-recording` का समर्थन करता है।
- `system.notify` `--priority <passive|active|timeSensitive>` और `--delivery <system|overlay|auto>` का समर्थन करता है।
- macOS नोड्स `PATH` overrides को छोड़ देते हैं; headless node hosts केवल `PATH` स्वीकार करते हैं जब वह node host PATH को prepend करता है।
- Ask/allowlist/full का व्यवहार headless node host जैसा ही है; अस्वीकृत प्रॉम्प्ट्स `SYSTEM_RUN_DENIED` लौटाते हैं।
  जब कई nodes उपलब्ध हों, आप exec को किसी विशिष्ट node से बाँध सकते हैं।
- headless node host पर, `system.run` exec approvals (`~/.openclaw/exec-approvals.json`) द्वारा gated होता है।

## Exec नोड बाइंडिंग

यह `exec host=node` के लिए डिफ़ॉल्ट node सेट करता है (और प्रति agent ओवरराइड किया जा सकता है)।
OpenClaw एक **headless node host** (कोई UI नहीं) चला सकता है जो Gateway WebSocket से कनेक्ट होता है और `system.run` / `system.which` एक्सपोज़ करता है।

ग्लोबल डिफ़ॉल्ट:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

प्रति-एजेंट ओवरराइड:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

किसी भी नोड की अनुमति देने के लिए unset करें:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## अनुमतियाँ मानचित्र

नोड्स `node.list` / `node.describe` में एक `permissions` मानचित्र शामिल कर सकते हैं, जो अनुमति नाम (जैसे `screenRecording`, `accessibility`) द्वारा keyed होता है और boolean मान (`true` = granted) रखता है।

## Headless node host (क्रॉस-प्लैटफ़ॉर्म)

यह Linux/Windows पर या किसी सर्वर के साथ एक न्यूनतम node चलाने के लिए उपयोगी है। macOS पर, headless node host जब उपलब्ध हो तो companion app exec host को प्राथमिकता देता है और ऐप अनुपलब्ध होने पर लोकल execution पर वापस चला जाता है।

इसे शुरू करें:

```bash
openclaw node run --host <gateway-host> --port 18789
```

नोट्स:

- पेयरिंग अभी भी आवश्यक है (Gateway एक नोड अनुमोदन प्रॉम्प्ट दिखाएगा)।
- node host अपना node id, token, display name, और gateway कनेक्शन जानकारी `~/.openclaw/node.json` में संग्रहीत करता है।
- Exec approvals स्थानीय रूप से `~/.openclaw/exec-approvals.json` के माध्यम से लागू होते हैं
  (देखें [Exec approvals](/tools/exec-approvals))।
- ऐप की आवश्यकता के लिए `OPENCLAW_NODE_EXEC_HOST=app` सेट करें, या fallback अक्षम करने के लिए `OPENCLAW_NODE_EXEC_FALLBACK=0` सेट करें। OS अनुमतियाँ बहु‑स्तरीय होती हैं।
- जब Gateway WS TLS का उपयोग करता हो, तब `--tls` / `--tls-fingerprint` जोड़ें।

## Mac node mode

- macOS मेन्यूबार ऐप Gateway WS सर्वर से एक नोड के रूप में कनेक्ट होता है (ताकि `openclaw nodes …` इस Mac के विरुद्ध काम करे)।
- रिमोट मोड में, ऐप Gateway पोर्ट के लिए एक SSH टनल खोलता है और `localhost` से कनेक्ट होता है।
