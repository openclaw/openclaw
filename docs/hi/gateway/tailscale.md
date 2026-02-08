---
summary: "Gateway डैशबोर्ड के लिए एकीकृत Tailscale Serve/Funnel"
read_when:
  - localhost के बाहर Gateway Control UI को एक्सपोज़ करना
  - tailnet या सार्वजनिक डैशबोर्ड एक्सेस को स्वचालित करना
title: "Tailscale"
x-i18n:
  source_path: gateway/tailscale.md
  source_hash: c4842b10848d4fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:22Z
---

# Tailscale (Gateway डैशबोर्ड)

OpenClaw Gateway डैशबोर्ड और WebSocket पोर्ट के लिए Tailscale **Serve** (tailnet) या **Funnel** (सार्वजनिक) को स्वतः कॉन्फ़िगर कर सकता है। इससे Gateway loopback पर बंधा रहता है, जबकि Tailscale HTTPS, रूटिंग, और (Serve के लिए) पहचान हेडर्स प्रदान करता है।

## मोड्स

- `serve`: `tailscale serve` के माध्यम से केवल Tailnet Serve। Gateway `127.0.0.1` पर रहता है।
- `funnel`: `tailscale funnel` के माध्यम से सार्वजनिक HTTPS। OpenClaw को साझा पासवर्ड की आवश्यकता होती है।
- `off`: डिफ़ॉल्ट (कोई Tailscale ऑटोमेशन नहीं)।

## प्रमाणीकरण

हैंडशेक नियंत्रित करने के लिए `gateway.auth.mode` सेट करें:

- `token` (जब `OPENCLAW_GATEWAY_TOKEN` सेट हो तो डिफ़ॉल्ट)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` या विन्यास के माध्यम से साझा सीक्रेट)

जब `tailscale.mode = "serve"` और `gateway.auth.allowTailscale` `true` हो,
तो वैध Serve प्रॉक्सी अनुरोध Tailscale पहचान हेडर्स
(`tailscale-user-login`) के माध्यम से, बिना किसी टोकन/पासवर्ड के, प्रमाणित हो सकते हैं। OpenClaw
स्थानीय Tailscale डेमन (`tailscale whois`) के माध्यम से `x-forwarded-for` पते को रिज़ॉल्व करके
और उसे हेडर से मिलान करके पहचान की पुष्टि करता है, उसके बाद ही अनुरोध स्वीकार करता है।
OpenClaw किसी अनुरोध को केवल तभी Serve मानता है जब वह loopback से
Tailscale के `x-forwarded-for`, `x-forwarded-proto`, और `x-forwarded-host`
हेडर्स के साथ पहुँचे।
स्पष्ट क्रेडेंशियल्स की आवश्यकता के लिए `gateway.auth.allowTailscale: false` सेट करें या
`gateway.auth.mode: "password"` को मजबूर करें।

## विन्यास उदाहरण

### केवल Tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

खोलें: `https://<magicdns>/` (या आपका कॉन्फ़िगर किया हुआ `gateway.controlUi.basePath`)

### केवल Tailnet (Tailnet IP पर बाइंड)

इसे तब उपयोग करें जब आप Gateway को सीधे Tailnet IP पर सुनना चाहते हों (कोई Serve/Funnel नहीं)।

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

किसी अन्य Tailnet डिवाइस से कनेक्ट करें:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

टिप्पणी: इस मोड में loopback (`http://127.0.0.1:18789`) **काम नहीं** करेगा।

### सार्वजनिक इंटरनेट (Funnel + साझा पासवर्ड)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

पासवर्ड को डिस्क पर कमिट करने के बजाय `OPENCLAW_GATEWAY_PASSWORD` को प्राथमिकता दें।

## CLI उदाहरण

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## टिप्पणियाँ

- Tailscale Serve/Funnel के लिए `tailscale` CLI का इंस्टॉल और लॉग-इन होना आवश्यक है।
- `tailscale.mode: "funnel"` सार्वजनिक एक्सपोज़र से बचने के लिए, जब तक auth मोड `password` न हो, शुरू होने से इंकार करता है।
- यदि आप शटडाउन पर OpenClaw से `tailscale serve` या
  `tailscale funnel` विन्यास को पूर्ववत कराना चाहते हैं, तो `gateway.tailscale.resetOnExit` सेट करें।
- `gateway.bind: "tailnet"` एक प्रत्यक्ष Tailnet बाइंड है (कोई HTTPS नहीं, कोई Serve/Funnel नहीं)।
- `gateway.bind: "auto"` loopback को प्राथमिकता देता है; यदि आप केवल Tailnet चाहते हैं तो `tailnet` का उपयोग करें।
- Serve/Funnel केवल **Gateway control UI + WS** को एक्सपोज़ करते हैं। नोड्स
  उसी Gateway WS एंडपॉइंट के माध्यम से कनेक्ट होते हैं, इसलिए Serve नोड एक्सेस के लिए काम कर सकता है।

## ब्राउज़र नियंत्रण (दूरस्थ Gateway + स्थानीय ब्राउज़र)

यदि आप Gateway को एक मशीन पर चलाते हैं लेकिन किसी दूसरी मशीन पर ब्राउज़र नियंत्रित करना चाहते हैं,
तो ब्राउज़र मशीन पर एक **node host** चलाएँ और दोनों को एक ही tailnet पर रखें।
Gateway ब्राउज़र क्रियाओं को नोड तक प्रॉक्सी करेगा; किसी अलग कंट्रोल सर्वर या Serve URL की आवश्यकता नहीं है।

ब्राउज़र नियंत्रण के लिए Funnel से बचें; नोड पेयरिंग को ऑपरेटर एक्सेस की तरह मानें।

## Tailscale पूर्वापेक्षाएँ + सीमाएँ

- Serve के लिए आपके tailnet पर HTTPS सक्षम होना आवश्यक है; यदि यह अनुपस्थित हो तो CLI संकेत देता है।
- Serve Tailscale पहचान हेडर्स इंजेक्ट करता है; Funnel नहीं करता।
- Funnel के लिए Tailscale v1.38.3+, MagicDNS, HTTPS सक्षम, और एक funnel नोड एट्रिब्यूट आवश्यक है।
- Funnel TLS पर केवल `443`, `8443`, और `10000` पोर्ट्स का समर्थन करता है।
- macOS पर Funnel के लिए ओपन-सोर्स Tailscale ऐप वेरिएंट आवश्यक है।

## और जानें

- Tailscale Serve अवलोकन: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` कमांड: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel अवलोकन: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` कमांड: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
