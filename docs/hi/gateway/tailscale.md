---
summary: "Gateway डैशबोर्ड के लिए एकीकृत Tailscale Serve/Funnel"
read_when:
  - localhost के बाहर Gateway Control UI को एक्सपोज़ करना
  - tailnet या सार्वजनिक डैशबोर्ड एक्सेस को स्वचालित करना
title: "Tailscale"
---

# Tailscale (Gateway डैशबोर्ड)

OpenClaw can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the
Gateway dashboard and WebSocket port. This keeps the Gateway bound to loopback while
Tailscale provides HTTPS, routing, and (for Serve) identity headers.

## मोड्स

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`: Public HTTPS via `tailscale funnel`. OpenClaw requires a shared password.
- `off`: डिफ़ॉल्ट (कोई Tailscale ऑटोमेशन नहीं)।

## प्रमाणीकरण

हैंडशेक नियंत्रित करने के लिए `gateway.auth.mode` सेट करें:

- `token` (जब `OPENCLAW_GATEWAY_TOKEN` सेट हो तो डिफ़ॉल्ट)
- `password` (`OPENCLAW_GATEWAY_PASSWORD` या विन्यास के माध्यम से साझा सीक्रेट)

When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
valid Serve proxy requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) without supplying a token/password. OpenClaw verifies
the identity by resolving the `x-forwarded-for` address via the local Tailscale
daemon (`tailscale whois`) and matching it to the header before accepting it.
OpenClaw only treats a request as Serve when it arrives from loopback with
Tailscale’s `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`
headers.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

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
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over
  the same Gateway WS endpoint, so Serve can work for node access.

## ब्राउज़र नियंत्रण (दूरस्थ Gateway + स्थानीय ब्राउज़र)

If you run the Gateway on one machine but want to drive a browser on another machine,
run a **node host** on the browser machine and keep both on the same tailnet.
Gateway ब्राउज़र क्रियाओं को नोड तक प्रॉक्सी करेगा; अलग कंट्रोल सर्वर या Serve URL की ज़रूरत नहीं।

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
