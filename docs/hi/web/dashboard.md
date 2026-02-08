---
summary: "Gateway डैशबोर्ड (Control UI) की पहुँच और प्रमाणीकरण"
read_when:
  - डैशबोर्ड प्रमाणीकरण या एक्सपोज़र मोड बदलते समय
title: "डैशबोर्ड"
x-i18n:
  source_path: web/dashboard.md
  source_hash: e4fc372b72f030f9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:47Z
---

# डैशबोर्ड (Control UI)

Gateway डैशबोर्ड ब्राउज़र-आधारित Control UI है, जो डिफ़ॉल्ट रूप से `/` पर परोसा जाता है
(इसे `gateway.controlUi.basePath` से ओवरराइड किया जा सकता है)।

त्वरित खोलें (स्थानीय Gateway):

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (या [http://localhost:18789/](http://localhost:18789/))

मुख्य संदर्भ:

- उपयोग और UI क्षमताओं के लिए [Control UI](/web/control-ui)।
- Serve/Funnel ऑटोमेशन के लिए [Tailscale](/gateway/tailscale)।
- बाइंड मोड और सुरक्षा नोट्स के लिए [Web surfaces](/web)।

प्रमाणीकरण WebSocket हैंडशेक के दौरान `connect.params.auth`
(टोकन या पासवर्ड) के माध्यम से लागू किया जाता है। [Gateway configuration](/gateway/configuration) में `gateway.auth` देखें।

सुरक्षा टिप्पणी: Control UI एक **एडमिन सतह** है (चैट, कॉन्फ़िग, exec अनुमोदन)।
इसे सार्वजनिक रूप से एक्सपोज़ न करें। UI पहली बार लोड होने के बाद टोकन को `localStorage` में संग्रहीत करता है।
localhost, Tailscale Serve, या SSH टनल को प्राथमिकता दें।

## त्वरित मार्ग (अनुशंसित)

- ऑनबोर्डिंग के बाद, CLI स्वतः डैशबोर्ड खोलता है और एक साफ़ (बिना-टोकन) लिंक प्रिंट करता है।
- कभी भी पुनः खोलें: `openclaw dashboard` (लिंक कॉपी करता है, संभव हो तो ब्राउज़र खोलता है, और headless होने पर SSH संकेत दिखाता है)।
- यदि UI प्रमाणीकरण के लिए पूछे, तो `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) से टोकन कॉपी करके Control UI सेटिंग्स में पेस्ट करें।

## टोकन की मूल बातें (स्थानीय बनाम दूरस्थ)

- **Localhost**: `http://127.0.0.1:18789/` खोलें।
- **टोकन स्रोत**: `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`); कनेक्ट करने के बाद UI localStorage में एक प्रति संग्रहीत करता है।
- **Localhost नहीं**: Tailscale Serve का उपयोग करें (यदि `gateway.auth.allowTailscale: true` हो तो बिना टोकन), टोकन के साथ tailnet बाइंड, या SSH टनल। [Web surfaces](/web) देखें।

## यदि “unauthorized” / 1008 दिखे

- सुनिश्चित करें कि gateway पहुँच योग्य है (स्थानीय: `openclaw status`; दूरस्थ: SSH टनल `ssh -N -L 18789:127.0.0.1:18789 user@host` फिर `http://127.0.0.1:18789/` खोलें)।
- Gateway होस्ट से टोकन प्राप्त करें: `openclaw config get gateway.auth.token` (या एक नया बनाएँ: `openclaw doctor --generate-gateway-token`)।
- डैशबोर्ड सेटिंग्स में, auth फ़ील्ड में टोकन पेस्ट करें, फिर कनेक्ट करें।
