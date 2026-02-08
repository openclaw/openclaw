---
summary: "Gateway वेब सतहें: कंट्रोल UI, बाइंड मोड, और सुरक्षा"
read_when:
  - आप Tailscale के माध्यम से Gateway तक पहुँचना चाहते हैं
  - आप ब्राउज़र कंट्रोल UI और कॉन्फ़िग संपादन चाहते हैं
title: "वेब"
x-i18n:
  source_path: web/index.md
  source_hash: 1315450b71a799c8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:48Z
---

# वेब (Gateway)

Gateway, Gateway WebSocket के समान पोर्ट से एक छोटा **ब्राउज़र कंट्रोल UI** (Vite + Lit) परोसता है:

- डिफ़ॉल्ट: `http://<host>:18789/`
- वैकल्पिक प्रीफ़िक्स: `gateway.controlUi.basePath` सेट करें (उदा. `/openclaw`)

क्षमताएँ [Control UI](/web/control-ui) में उपलब्ध हैं।
यह पृष्ठ बाइंड मोड, सुरक्षा, और वेब-फेसिंग सतहों पर केंद्रित है।

## वेबहुक्स

जब `hooks.enabled=true`, Gateway उसी HTTP सर्वर पर एक छोटा वेबहुक एंडपॉइंट भी उपलब्ध कराता है।
प्रमाणीकरण + पेलोड्स के लिए [Gateway configuration](/gateway/configuration) → `hooks` देखें।

## कॉन्फ़िग (डिफ़ॉल्ट-ऑन)

एसेट्स मौजूद होने पर कंट्रोल UI **डिफ़ॉल्ट रूप से सक्षम** रहता है (`dist/control-ui`)।
आप इसे कॉन्फ़िग के माध्यम से नियंत्रित कर सकते हैं:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale एक्सेस

### Integrated Serve (अनुशंसित)

Gateway को loopback पर रखें और Tailscale Serve से इसे प्रॉक्सी करें:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

फिर Gateway शुरू करें:

```bash
openclaw gateway
```

खोलें:

- `https://<magicdns>/` (या आपका कॉन्फ़िगर किया हुआ `gateway.controlUi.basePath`)

### Tailnet बाइंड + टोकन

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

फिर Gateway शुरू करें (नॉन-loopback बाइंड्स के लिए टोकन आवश्यक):

```bash
openclaw gateway
```

खोलें:

- `http://<tailscale-ip>:18789/` (या आपका कॉन्फ़िगर किया हुआ `gateway.controlUi.basePath`)

### सार्वजनिक इंटरनेट (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## सुरक्षा नोट्स

- Gateway प्रमाणीकरण डिफ़ॉल्ट रूप से आवश्यक है (टोकन/पासवर्ड या Tailscale पहचान हेडर्स)।
- नॉन-loopback बाइंड्स के लिए अभी भी **आवश्यक** है एक साझा टोकन/पासवर्ड (`gateway.auth` या env)।
- विज़ार्ड डिफ़ॉल्ट रूप से एक Gateway टोकन जनरेट करता है (loopback पर भी)।
- UI `connect.params.auth.token` या `connect.params.auth.password` भेजता है।
- कंट्रोल UI एंटी-क्लिकजैकिंग हेडर्स भेजता है और केवल same-origin ब्राउज़र
  वेब-सॉकेट कनेक्शनों को स्वीकार करता है, जब तक कि `gateway.controlUi.allowedOrigins` सेट न हो।
- Serve के साथ, Tailscale पहचान हेडर्स प्रमाणीकरण को पूरा कर सकते हैं जब
  `gateway.auth.allowTailscale` `true` हो (कोई टोकन/पासवर्ड आवश्यक नहीं)। स्पष्ट क्रेडेंशियल्स अनिवार्य करने के लिए
  `gateway.auth.allowTailscale: false` सेट करें। देखें
  [Tailscale](/gateway/tailscale) और [Security](/gateway/security)।
- `gateway.tailscale.mode: "funnel"` के लिए `gateway.auth.mode: "password"` (साझा पासवर्ड) आवश्यक है।

## UI का निर्माण

Gateway स्थिर फ़ाइलें `dist/control-ui` से परोसता है। इन्हें इस प्रकार बनाएँ:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
