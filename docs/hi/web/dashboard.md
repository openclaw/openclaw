---
summary: "Gateway डैशबोर्ड (Control UI) की पहुँच और प्रमाणीकरण"
read_when:
  - डैशबोर्ड प्रमाणीकरण या एक्सपोज़र मोड बदलते समय
title: "डैशबोर्ड"
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

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [Gateway configuration](/gateway/configuration).

Security note: the Control UI is an **admin surface** (chat, config, exec approvals).
Do not expose it publicly. The UI stores the token in `localStorage` after first load.
Prefer localhost, Tailscale Serve, or an SSH tunnel.

## त्वरित मार्ग (अनुशंसित)

- ऑनबोर्डिंग के बाद, CLI स्वतः डैशबोर्ड खोलता है और एक साफ़ (बिना-टोकन) लिंक प्रिंट करता है।
- कभी भी पुनः खोलें: `openclaw dashboard` (लिंक कॉपी करता है, संभव हो तो ब्राउज़र खोलता है, और headless होने पर SSH संकेत दिखाता है)।
- यदि UI प्रमाणीकरण के लिए पूछे, तो `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`) से टोकन कॉपी करके Control UI सेटिंग्स में पेस्ट करें।

## टोकन की मूल बातें (स्थानीय बनाम दूरस्थ)

- **Localhost**: `http://127.0.0.1:18789/` खोलें।
- **टोकन स्रोत**: `gateway.auth.token` (या `OPENCLAW_GATEWAY_TOKEN`); कनेक्ट करने के बाद UI localStorage में एक प्रति संग्रहीत करता है।
- **Not localhost**: use Tailscale Serve (tokenless if `gateway.auth.allowTailscale: true`), tailnet bind with a token, or an SSH tunnel. See [Web surfaces](/web).

## यदि “unauthorized” / 1008 दिखे

- सुनिश्चित करें कि gateway पहुँच योग्य है (स्थानीय: `openclaw status`; दूरस्थ: SSH टनल `ssh -N -L 18789:127.0.0.1:18789 user@host` फिर `http://127.0.0.1:18789/` खोलें)।
- Gateway होस्ट से टोकन प्राप्त करें: `openclaw config get gateway.auth.token` (या एक नया बनाएँ: `openclaw doctor --generate-gateway-token`)।
- डैशबोर्ड सेटिंग्स में, auth फ़ील्ड में टोकन पेस्ट करें, फिर कनेक्ट करें।
