---
summary: "Gateway के लिए ब्राउज़र-आधारित नियंत्रण UI (चैट, नोड्स, विन्यास)"
read_when:
  - आप Gateway को ब्राउज़र से संचालित करना चाहते हैं
  - आप SSH टनलों के बिना Tailnet एक्सेस चाहते हैं
title: "कंट्रोल UI"
---

# कंट्रोल UI (ब्राउज़र)

कंट्रोल UI एक छोटा **Vite + Lit** सिंगल‑पेज ऐप है जिसे Gateway द्वारा परोसा जाता है:

- डिफ़ॉल्ट: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

यह उसी पोर्ट पर **Gateway WebSocket** से **सीधे** बात करता है।

## त्वरित खोलें (लोकल)

यदि Gateway उसी कंप्यूटर पर चल रहा है, तो खोलें:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (या [http://localhost:18789/](http://localhost:18789/))

यदि पेज लोड नहीं होता, तो पहले Gateway शुरू करें: `openclaw gateway`.

प्रमाणीकरण WebSocket हैंडशेक के दौरान निम्न के माध्यम से प्रदान किया जाता है:

- `connect.params.auth.token`
- `connect.params.auth.password`
  The dashboard settings panel lets you store a token; passwords are not persisted.
  The onboarding wizard generates a gateway token by default, so paste it here on first connect.

## डिवाइस पेयरिंग (पहला कनेक्शन)

When you connect to the Control UI from a new browser or device, the Gateway
requires a **one-time pairing approval** — even if you're on the same Tailnet
with `gateway.auth.allowTailscale: true`. This is a security measure to prevent
unauthorized access.

**आप क्या देखेंगे:** "disconnected (1008): pairing required"

**डिवाइस को अनुमोदित करने के लिए:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Once approved, the device is remembered and won't require re-approval unless
you revoke it with `openclaw devices revoke --device <id> --role <role>`. See
[Devices CLI](/cli/devices) for token rotation and revocation.

**टिप्पणियाँ:**

- लोकल कनेक्शन (`127.0.0.1`) स्वतः अनुमोदित होते हैं।
- Remote connections (LAN, Tailnet, etc.) require explicit approval.
- प्रत्येक ब्राउज़र प्रोफ़ाइल एक अद्वितीय डिवाइस ID बनाती है, इसलिए ब्राउज़र बदलने या
  ब्राउज़र डेटा साफ़ करने पर पुनः‑पेयरिंग की आवश्यकता होगी।

## यह आज क्या कर सकता है

- Gateway WS के माध्यम से मॉडल के साथ चैट (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- चैट में टूल कॉल स्ट्रीम करना + लाइव टूल आउटपुट कार्ड (एजेंट इवेंट्स)
- Channels: WhatsApp/Telegram/Discord/Slack + plugin channels (Mattermost, etc.) status + QR login + per-channel config (`channels.status`, `web.login.*`, `config.patch`)
- इंस्टेंस: प्रेज़ेन्स सूची + रिफ़्रेश (`system-presence`)
- सत्र: सूची + प्रति‑सत्र thinking/verbose ओवरराइड (`sessions.list`, `sessions.patch`)
- क्रॉन जॉब्स: सूची/जोड़ें/चलाएँ/सक्षम/अक्षम + रन इतिहास (`cron.*`)
- Skills: स्थिति, सक्षम/अक्षम, इंस्टॉल, API कुंजी अपडेट (`skills.*`)
- नोड्स: सूची + क्षमताएँ (`node.list`)
- Exec अनुमोदन: gateway या नोड allowlists संपादित करें + `exec host=gateway/node` के लिए नीति पूछें (`exec.approvals.*`)
- विन्यास: देखें/संपादित करें `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- विन्यास: सत्यापन (`config.apply`) के साथ लागू करें + पुनः प्रारंभ करें और अंतिम सक्रिय सत्र को जगाएँ
- विन्यास लेखन में समवर्ती संपादनों को ओवरराइट होने से रोकने के लिए base-hash गार्ड शामिल है
- विन्यास स्कीमा + फ़ॉर्म रेंडरिंग (`config.schema`, जिसमें प्लगइन + चैनल स्कीमा शामिल हैं); Raw JSON संपादक उपलब्ध रहता है
- डिबग: स्थिति/स्वास्थ्य/मॉडल स्नैपशॉट्स + इवेंट लॉग + मैनुअल RPC कॉल (`status`, `health`, `models.list`)
- लॉग्स: फ़िल्टर/एक्सपोर्ट के साथ gateway फ़ाइल लॉग्स का लाइव टेल (`logs.tail`)
- अपडेट: पैकेज/git अपडेट चलाएँ + पुनः प्रारंभ करें (`update.run`) और एक रीस्टार्ट रिपोर्ट के साथ

क्रॉन जॉब्स पैनल नोट्स:

- For isolated jobs, delivery defaults to announce summary. You can switch to none if you want internal-only runs.
- जब announce चुना जाता है, तब चैनल/टार्गेट फ़ील्ड दिखाई देते हैं।

## चैट व्यवहार

- `chat.send` **नॉन‑ब्लॉकिंग** है: यह तुरंत `{ runId, status: "started" }` के साथ ack करता है और प्रतिक्रिया `chat` इवेंट्स के माध्यम से स्ट्रीम होती है।
- उसी `idempotencyKey` के साथ पुनः भेजने पर, चलने के दौरान `{ status: "in_flight" }` और पूर्ण होने के बाद `{ status: "ok" }` लौटता है।
- `chat.inject` सत्र ट्रांसक्रिप्ट में एक सहायक नोट जोड़ता है और UI‑केवल अपडेट्स के लिए `chat` इवेंट प्रसारित करता है (कोई एजेंट रन नहीं, कोई चैनल डिलीवरी नहीं)।
- रोकें:
  - **Stop** पर क्लिक करें ( `chat.abort` कॉल करता है)
  - `/stop` टाइप करें (या `stop|esc|abort|wait|exit|interrupt`) ताकि आउट‑ऑफ़‑बैंड निरस्त किया जा सके
  - `chat.abort` `{ sessionKey }` का समर्थन करता है (कोई `runId` नहीं) ताकि उस सत्र के सभी सक्रिय रन निरस्त किए जा सकें

## Tailnet एक्सेस (अनुशंसित)

### एकीकृत Tailscale Serve (पसंदीदा)

Gateway को loopback पर रखें और Tailscale Serve को HTTPS के साथ इसे प्रॉक्सी करने दें:

```bash
openclaw gateway --tailscale serve
```

खोलें:

- `https://<magicdns>/` (या आपका विन्यस्त `gateway.controlUi.basePath`)

By default, Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. OpenClaw
verifies the identity by resolving the `x-forwarded-for` address with
`tailscale whois` and matching it to the header, and only accepts these when the
request hits loopback with Tailscale’s `x-forwarded-*` headers. Set
`gateway.auth.allowTailscale: false` (or force `gateway.auth.mode: "password"`)
if you want to require a token/password even for Serve traffic.

### Tailnet से बाइंड + टोकन

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

फिर खोलें:

- `http://<tailscale-ip>:18789/` (या आपका विन्यस्त `gateway.controlUi.basePath`)

टोकन को UI सेटिंग्स में पेस्ट करें ( `connect.params.auth.token` के रूप में भेजा जाता है)।

## असुरक्षित HTTP

If you open the dashboard over plain HTTP (`http://<lan-ip>` or `http://<tailscale-ip>`),
the browser runs in a **non-secure context** and blocks WebCrypto. By default,
OpenClaw **blocks** Control UI connections without device identity.

**अनुशंसित समाधान:** HTTPS (Tailscale Serve) का उपयोग करें या UI को लोकली खोलें:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (Gateway होस्ट पर)

**डाउनग्रेड उदाहरण (HTTP पर केवल‑टोकन):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

This disables device identity + pairing for the Control UI (even on HTTPS). Use
only if you trust the network.

HTTPS सेटअप मार्गदर्शन के लिए [Tailscale](/gateway/tailscale) देखें।

## UI बनाना

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

वैकल्पिक absolute base (जब आप स्थिर एसेट URL चाहते हैं):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

लोकल विकास के लिए (अलग dev सर्वर):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

## डिबगिंग/टेस्टिंग: dev सर्वर + रिमोट Gateway

The Control UI is static files; the WebSocket target is configurable and can be
different from the HTTP origin. This is handy when you want the Vite dev server
locally but the Gateway runs elsewhere.

1. UI dev सर्वर शुरू करें: `pnpm ui:dev`
2. इस प्रकार का URL खोलें:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

वैकल्पिक एक‑बार प्रमाणीकरण (यदि आवश्यक हो):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

नोट्स:

- `gatewayUrl` लोड के बाद localStorage में संग्रहीत होता है और URL से हटा दिया जाता है।
- `token` localStorage में संग्रहीत होता है; `password` केवल मेमोरी में रखा जाता है।
- When `gatewayUrl` is set, the UI does not fall back to config or environment credentials.
  Provide `token` (or `password`) explicitly. Missing explicit credentials is an error.
- जब Gateway TLS (Tailscale Serve, HTTPS प्रॉक्सी, आदि) के पीछे हो, तो `wss://` का उपयोग करें।
- क्लिकजैकिंग रोकने के लिए `gatewayUrl` केवल टॉप‑लेवल विंडो में स्वीकार किया जाता है (एम्बेडेड नहीं)।
- For cross-origin dev setups (e.g. `pnpm ui:dev` to a remote Gateway), add the UI
  origin to `gateway.controlUi.allowedOrigins`.

उदाहरण:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

रिमोट एक्सेस सेटअप विवरण: [Remote access](/gateway/remote)।
