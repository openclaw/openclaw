---
summary: "Android ऐप (नोड): कनेक्शन रनबुक + Canvas/Chat/Camera"
read_when:
  - Android नोड का पेयरिंग या पुनः कनेक्शन
  - Android Gateway डिस्कवरी या प्रमाणीकरण का डिबगिंग
  - क्लाइंट्स के बीच चैट इतिहास समानता का सत्यापन
title: "Android ऐप"
---

# Android ऐप (नोड)

## समर्थन स्नैपशॉट

- भूमिका: सहचर नोड ऐप (Android Gateway होस्ट नहीं करता)।
- Gateway आवश्यक: हाँ (macOS, Linux, या Windows पर WSL2 के माध्यम से चलाएँ)।
- इंस्टॉल: [आरंभ करें](/start/getting-started) + [पेयरिंग](/gateway/pairing)।
- Gateway: [रनबुक](/gateway) + [विन्यास](/gateway/configuration)।
  - प्रोटोकॉल: [Gateway प्रोटोकॉल](/gateway/protocol) (नोड्स + कंट्रोल प्लेन)।

## सिस्टम नियंत्रण

System control (launchd/systemd) lives on the Gateway host. See [Gateway](/gateway).

## कनेक्शन रनबुक

Android नोड ऐप ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android सीधे Gateway WebSocket (डिफ़ॉल्ट `ws://<host>:18789`) से कनेक्ट होता है और Gateway-स्वामित्व वाले पेयरिंग का उपयोग करता है।

### पूर्वापेक्षाएँ

- आप “मास्टर” मशीन पर Gateway चला सकते हैं।
- Android डिवाइस/एम्युलेटर Gateway WebSocket तक पहुँच सकता है:
  - mDNS/NSD के साथ वही LAN, **या**
  - Wide-Area Bonjour / unicast DNS-SD का उपयोग करते हुए वही Tailscale tailnet (नीचे देखें), **या**
  - मैनुअल Gateway होस्ट/पोर्ट (फ़ॉलबैक)
- आप Gateway मशीन पर (या SSH के माध्यम से) CLI (`openclaw`) चला सकते हैं।

### 1. Gateway प्रारंभ करें

```bash
openclaw gateway --port 18789 --verbose
```

लॉग्स में पुष्टि करें कि आपको कुछ ऐसा दिखे:

- `listening on ws://0.0.0.0:18789`

केवल-tailnet सेटअप्स के लिए (Vienna ⇄ London के लिए अनुशंसित), Gateway को tailnet IP पर बाइंड करें:

- Gateway होस्ट पर `~/.openclaw/openclaw.json` में `gateway.bind: "tailnet"` सेट करें।
- Gateway / macOS मेनूबार ऐप पुनः प्रारंभ करें।

### 2. डिस्कवरी सत्यापित करें (वैकल्पिक)

Gateway मशीन से:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

अधिक डिबगिंग नोट्स: [Bonjour](/gateway/bonjour)।

#### unicast DNS-SD के माध्यम से Tailnet (Vienna ⇄ London) डिस्कवरी

Android NSD/mDNS discovery won’t cross networks. If your Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead:

1. Gateway होस्ट पर एक DNS-SD ज़ोन (उदाहरण `openclaw.internal.`) सेट करें और `_openclaw-gw._tcp` रिकॉर्ड प्रकाशित करें।
2. अपने चुने हुए डोमेन के लिए उस DNS सर्वर की ओर इंगित करते हुए Tailscale split DNS कॉन्फ़िगर करें।

विवरण और उदाहरण CoreDNS विन्यास: [Bonjour](/gateway/bonjour)।

### 3. Android से कनेक्ट करें

Android ऐप में:

- ऐप **foreground service** (स्थायी नोटिफ़िकेशन) के माध्यम से Gateway कनेक्शन जीवित रखता है।
- **Settings** खोलें।
- **Discovered Gateways** के अंतर्गत अपना Gateway चुनें और **Connect** दबाएँ।
- यदि mDNS ब्लॉक है, तो **Advanced → Manual Gateway** (होस्ट + पोर्ट) और **Connect (Manual)** का उपयोग करें।

पहली सफल पेयरिंग के बाद, Android लॉन्च पर स्वतः पुनः कनेक्ट करता है:

- मैनुअल एंडपॉइंट (यदि सक्षम), अन्यथा
- अंतिम डिस्कवर्ड Gateway (best-effort)।

### 4. पेयरिंग अनुमोदित करें (CLI)

Gateway मशीन पर:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

पेयरिंग विवरण: [Gateway पेयरिंग](/gateway/pairing)।

### 5. नोड कनेक्टेड है या नहीं सत्यापित करें

- नोड्स स्थिति के माध्यम से:

  ```bash
  openclaw nodes status
  ```

- Gateway के माध्यम से:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. चैट + इतिहास

Android नोड की Chat शीट Gateway की **प्राथमिक सत्र कुंजी** (`main`) का उपयोग करती है, इसलिए इतिहास और उत्तर WebChat और अन्य क्लाइंट्स के साथ साझा होते हैं:

- इतिहास: `chat.history`
- भेजें: `chat.send`
- पुश अपडेट्स (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + कैमरा

#### Gateway Canvas होस्ट (वेब कंटेंट के लिए अनुशंसित)

यदि आप चाहते हैं कि नोड वास्तविक HTML/CSS/JS दिखाए जिसे एजेंट डिस्क पर संपादित कर सके, तो नोड को Gateway canvas होस्ट की ओर इंगित करें।

टिप्पणी: नोड्स `canvasHost.port` पर standalone canvas होस्ट का उपयोग करते हैं (डिफ़ॉल्ट `18793`)।

1. Gateway होस्ट पर `~/.openclaw/workspace/canvas/index.html` बनाएँ।

2. नोड को उस पर नेविगेट करें (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (वैकल्पिक): यदि दोनों डिवाइस Tailscale पर हैं, तो `.local` के बजाय MagicDNS नाम या tailnet IP का उपयोग करें, उदाहरण के लिए `http://<gateway-magicdns>:18793/__openclaw__/canvas/`।

This server injects a live-reload client into HTML and reloads on file changes.
The A2UI host lives at `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Canvas कमांड्स (केवल foreground):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)

कैमरा कमांड्स (केवल foreground; अनुमति-नियंत्रित):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

पैरामीटर और CLI हेल्पर्स के लिए देखें: [Camera node](/nodes/camera)।
