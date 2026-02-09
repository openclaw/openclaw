---
summary: "SSH टनल (Gateway WS) और टेलनेट्स का उपयोग करके दूरस्थ पहुँच"
read_when:
  - दूरस्थ Gateway सेटअप चलाते समय या समस्या-निवारण करते समय
title: "दूरस्थ पहुँच"
---

# दूरस्थ पहुँच (SSH, टनल, और टेलनेट्स)

यह रिपॉज़िटरी “SSH के माध्यम से दूरस्थ” का समर्थन करती है, जिसमें एक समर्पित होस्ट (डेस्कटॉप/सर्वर) पर एकल Gateway (मास्टर) चलाया जाता है और क्लाइंट उससे जुड़ते हैं।

- **ऑपरेटरों (आप / macOS ऐप)** के लिए: SSH टनलिंग सार्वभौमिक फ़ॉलबैक है।
- **नोड्स (iOS/Android और भविष्य के डिवाइस)** के लिए: Gateway **WebSocket** से कनेक्ट करें (LAN/टेलनेट या आवश्यकता अनुसार SSH टनल)।

## मुख्य विचार

- Gateway WebSocket आपके कॉन्फ़िगर किए गए पोर्ट पर **loopback** से बाइंड होता है (डिफ़ॉल्ट 18789)।
- दूरस्थ उपयोग के लिए, उस loopback पोर्ट को SSH के माध्यम से फ़ॉरवर्ड करें (या टेलनेट/VPN का उपयोग करें और कम टनलिंग करें)।

## सामान्य VPN/टेलनेट सेटअप (जहाँ एजेंट रहता है)

**Gateway host** को ऐसे समझें जैसे “जहाँ एजेंट रहता है।” यह sessions, auth profiles, channels और state का स्वामी होता है।
आपका लैपटॉप/डेस्कटॉप (और nodes) उस होस्ट से कनेक्ट होते हैं।

### 1. आपके टेलनेट में हमेशा-चालू Gateway (VPS या होम सर्वर)

Gateway को किसी स्थायी होस्ट पर चलाएँ और **Tailscale** या SSH के माध्यम से पहुँचें।

- **सर्वोत्तम UX:** `gateway.bind: "loopback"` रखें और Control UI के लिए **Tailscale Serve** का उपयोग करें।
- **फ़ॉलबैक:** loopback बनाए रखें + जिस भी मशीन को पहुँच चाहिए उससे SSH टनल।
- **उदाहरण:** [exe.dev](/install/exe-dev) (आसान VM) या [Hetzner](/install/hetzner) (प्रोडक्शन VPS)।

यह तब आदर्श है जब आपका लैपटॉप अक्सर स्लीप में जाता है लेकिन आप एजेंट को हमेशा चालू रखना चाहते हैं।

### 2. होम डेस्कटॉप Gateway चलाता है, लैपटॉप रिमोट कंट्रोल है

लैपटॉप एजेंट को **नहीं** चलाता। यह रिमोट रूप से कनेक्ट होता है:

- macOS ऐप का **Remote over SSH** मोड उपयोग करें (Settings → General → “OpenClaw runs”)।
- ऐप टनल को खोलता और प्रबंधित करता है, इसलिए WebChat + स्वास्थ्य जाँच “बस काम करती हैं।”

रनबुक: [macOS remote access](/platforms/mac/remote)।

### 3. लैपटॉप Gateway चलाता है, अन्य मशीनों से दूरस्थ पहुँच

Gateway को स्थानीय रखें लेकिन सुरक्षित रूप से एक्सपोज़ करें:

- अन्य मशीनों से लैपटॉप तक SSH टनल, या
- Control UI के लिए Tailscale Serve और Gateway को केवल loopback पर रखें।

गाइड: [Tailscale](/gateway/tailscale) और [Web overview](/web)।

## कमांड फ़्लो (क्या कहाँ चलता है)

एक गेटवे सेवा state + channels की मालिक होती है। Nodes परिधीय (peripherals) होते हैं।

फ़्लो उदाहरण (Telegram → नोड):

- Telegram संदेश **Gateway** पर पहुँचता है।
- Gateway **agent** चलाता है और तय करता है कि किसी नोड टूल को कॉल करना है या नहीं।
- Gateway, Gateway WebSocket (`node.*` RPC) के माध्यम से **नोड** को कॉल करता है।
- नोड परिणाम लौटाता है; Gateway Telegram को उत्तर भेज देता है।

टिप्पणियाँ:

- **नोड्स gateway सेवा नहीं चलाते।** प्रति होस्ट केवल एक gateway चलना चाहिए, जब तक कि आप जानबूझकर पृथक प्रोफ़ाइल न चला रहे हों (देखें [Multiple gateways](/gateway/multiple-gateways))।
- macOS ऐप का “node mode” केवल Gateway WebSocket के माध्यम से एक नोड क्लाइंट है।

## SSH टनल (CLI + टूल्स)

दूरस्थ Gateway WS के लिए एक स्थानीय टनल बनाएँ:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

टनल चालू होने पर:

- `openclaw health` और `openclaw status --deep` अब `ws://127.0.0.1:18789` के माध्यम से दूरस्थ gateway तक पहुँचते हैं।
- `openclaw gateway {status,health,send,agent,call}` आवश्यकता होने पर `--url` के माध्यम से फ़ॉरवर्ड किए गए URL को भी लक्षित कर सकता है।

नोट: `18789` को अपने कॉन्फ़िगर किए गए `gateway.port` (या `--port`/`OPENCLAW_GATEWAY_PORT`) से बदलें।
नोट: जब आप `--url` पास करते हैं, तो CLI कॉन्फ़िग या environment credentials पर फ़ॉलबैक नहीं करता।
`--token` या `--password` को स्पष्ट रूप से शामिल करें। स्पष्ट credentials का न होना एक त्रुटि है।

## CLI दूरस्थ डिफ़ॉल्ट्स

आप एक दूरस्थ लक्ष्य को स्थायी कर सकते हैं ताकि CLI कमांड डिफ़ॉल्ट रूप से उसी का उपयोग करें:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

जब gateway केवल loopback हो, तो URL को `ws://127.0.0.1:18789` पर रखें और पहले SSH टनल खोलें।

## SSH के माध्यम से Chat UI

WebChat अब अलग HTTP पोर्ट का उपयोग नहीं करता। SwiftUI चैट UI सीधे Gateway WebSocket से कनेक्ट होता है।

- `18789` को SSH के माध्यम से फ़ॉरवर्ड करें (ऊपर देखें), फिर क्लाइंट्स को `ws://127.0.0.1:18789` से कनेक्ट करें।
- macOS पर, ऐप के “Remote over SSH” मोड को प्राथमिकता दें, जो टनल को स्वचालित रूप से प्रबंधित करता है।

## macOS ऐप “Remote over SSH”

macOS मेनू बार ऐप उसी सेटअप को एंड-टू-एंड संचालित कर सकता है (दूरस्थ स्थिति जाँच, WebChat, और Voice Wake फ़ॉरवर्डिंग)।

रनबुक: [macOS remote access](/platforms/mac/remote)।

## सुरक्षा नियम (remote/VPN)

संक्षिप्त संस्करण: **Gateway को loopback-only रखें** जब तक कि आपको बाइंड की आवश्यकता होने का पूरा भरोसा न हो।

- **Loopback + SSH/Tailscale Serve** सबसे सुरक्षित डिफ़ॉल्ट है (कोई सार्वजनिक एक्सपोज़र नहीं)।
- **नॉन-loopback बाइंड्स** (`lan`/`tailnet`/`custom`, या loopback उपलब्ध न होने पर `auto`) में auth टोकन/पासवर्ड का उपयोग अनिवार्य है।
- `gateway.remote.token` **केवल** दूरस्थ CLI कॉल्स के लिए है — यह स्थानीय प्रमाणीकरण सक्षम **नहीं** करता।
- `gateway.remote.tlsFingerprint` `wss://` का उपयोग करते समय दूरस्थ TLS प्रमाणपत्र को पिन करता है।
- **Tailscale Serve** `gateway.auth.allowTailscale: true` होने पर identity headers के माध्यम से प्रमाणित कर सकता है।
  यदि आप tokens/passwords चाहते हैं तो इसे `false` पर सेट करें।
- ब्राउज़र कंट्रोल को ऑपरेटर एक्सेस की तरह मानें: केवल टेलनेट + जानबूझकर नोड पेयरिंग।

विस्तृत जानकारी: [Security](/gateway/security)।
