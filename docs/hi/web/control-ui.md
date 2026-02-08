---
summary: "Gateway के लिए ब्राउज़र-आधारित नियंत्रण UI (चैट, नोड्स, विन्यास)"
read_when:
  - आप Gateway को ब्राउज़र से संचालित करना चाहते हैं
  - आप SSH टनलों के बिना Tailnet एक्सेस चाहते हैं
title: "कंट्रोल UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:06Z
---

# कंट्रोल UI (ब्राउज़र)

कंट्रोल UI एक छोटा **Vite + Lit** सिंगल‑पेज ऐप है जिसे Gateway द्वारा परोसा जाता है:

- डिफ़ॉल्ट: `http://<host>:18789/`
- वैकल्पिक प्रीफ़िक्स: `gateway.controlUi.basePath` सेट करें (उदा. `/openclaw`)

यह उसी पोर्ट पर **Gateway WebSocket** से **सीधे** बात करता है।

## त्वरित खोलें (लोकल)

यदि Gateway उसी कंप्यूटर पर चल रहा है, तो खोलें:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (या [http://localhost:18789/](http://localhost:18789/))

यदि पेज लोड नहीं होता, तो पहले Gateway शुरू करें: `openclaw gateway`.

प्रमाणीकरण WebSocket हैंडशेक के दौरान निम्न के माध्यम से प्रदान किया जाता है:

- `connect.params.auth.token`
- `connect.params.auth.password`
  डैशबोर्ड सेटिंग्स पैनल आपको एक टोकन सहेजने देता है; पासवर्ड स्थायी रूप से संग्रहीत नहीं किए जाते।
  ऑनबोर्डिंग विज़ार्ड डिफ़ॉल्ट रूप से एक gateway टोकन बनाता है, इसलिए पहली कनेक्शन पर इसे यहाँ पेस्ट करें।

## डिवाइस पेयरिंग (पहला कनेक्शन)

जब आप किसी नए ब्राउज़र या डिवाइस से कंट्रोल UI से जुड़ते हैं, तो Gateway
**एक‑बार की पेयरिंग अनुमोदन** की आवश्यकता करता है — भले ही आप उसी Tailnet पर हों
और `gateway.auth.allowTailscale: true` के साथ हों। यह
अनधिकृत पहुँच को रोकने के लिए एक सुरक्षा उपाय है।

**आप क्या देखेंगे:** "disconnected (1008): pairing required"

**डिवाइस को अनुमोदित करने के लिए:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

एक बार अनुमोदित होने के बाद, डिवाइस याद रखा जाता है और पुनः‑अनुमोदन की आवश्यकता नहीं होगी
जब तक कि आप इसे `openclaw devices revoke --device <id> --role <role>` के साथ निरस्त न करें। देखें
[Devices CLI](/cli/devices) टोकन रोटेशन और निरस्तीकरण के लिए।

**टिप्पणियाँ:**

- लोकल कनेक्शन (`127.0.0.1`) स्वतः अनुमोदित होते हैं।
- रिमोट कनेक्शन (LAN, Tailnet, आदि) के लिए स्पष्ट अनुमोदन आवश्यक है।
- प्रत्येक ब्राउज़र प्रोफ़ाइल एक अद्वितीय डिवाइस ID बनाती है, इसलिए ब्राउज़र बदलने या
  ब्राउज़र डेटा साफ़ करने पर पुनः‑पेयरिंग की आवश्यकता होगी।

## यह आज क्या कर सकता है

- Gateway WS के माध्यम से मॉडल के साथ चैट (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- चैट में टूल कॉल स्ट्रीम करना + लाइव टूल आउटपुट कार्ड (एजेंट इवेंट्स)
- चैनल्स: WhatsApp/Telegram/Discord/Slack + प्लगइन चैनल्स (Mattermost, आदि) की स्थिति + QR लॉगिन + प्रति‑चैनल विन्यास (`channels.status`, `web.login.*`, `config.patch`)
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

- अलग‑थलग जॉब्स के लिए, डिलीवरी डिफ़ॉल्ट रूप से announce summary होती है। यदि आप केवल आंतरिक रन चाहते हैं, तो none पर स्विच कर सकते हैं।
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

डिफ़ॉल्ट रूप से, Serve अनुरोध Tailscale पहचान हेडर्स
(`tailscale-user-login`) के माध्यम से प्रमाणीकरण कर सकते हैं जब `gateway.auth.allowTailscale` `true` हो।
OpenClaw पहचान का सत्यापन `x-forwarded-for` पते को
`tailscale whois` के साथ रिज़ॉल्व करके और उसे हेडर से मिलान करके करता है, और इन्हें केवल तब स्वीकार करता है जब
अनुरोध loopback पर Tailscale के `x-forwarded-*` हेडर्स के साथ पहुँचता है। सेट करें
`gateway.auth.allowTailscale: false` (या `gateway.auth.mode: "password"` को फ़ोर्स करें)
यदि आप Serve ट्रैफ़िक के लिए भी टोकन/पासवर्ड अनिवार्य करना चाहते हैं।

### Tailnet से बाइंड + टोकन

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

फिर खोलें:

- `http://<tailscale-ip>:18789/` (या आपका विन्यस्त `gateway.controlUi.basePath`)

टोकन को UI सेटिंग्स में पेस्ट करें ( `connect.params.auth.token` के रूप में भेजा जाता है)।

## असुरक्षित HTTP

यदि आप साधारण HTTP पर डैशबोर्ड खोलते हैं (`http://<lan-ip>` या `http://<tailscale-ip>`),
तो ब्राउज़र **नॉन‑सिक्योर कॉन्टेक्स्ट** में चलता है और WebCrypto को ब्लॉक कर देता है। डिफ़ॉल्ट रूप से,
OpenClaw डिवाइस पहचान के बिना कंट्रोल UI कनेक्शनों को **ब्लॉक** करता है।

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

यह कंट्रोल UI के लिए डिवाइस पहचान + पेयरिंग को अक्षम करता है (HTTPS पर भी)। उपयोग
केवल तब करें जब आप नेटवर्क पर भरोसा करते हों।

HTTPS सेटअप मार्गदर्शन के लिए [Tailscale](/gateway/tailscale) देखें।

## UI बनाना

Gateway `dist/control-ui` से स्थिर फ़ाइलें परोसता है। इन्हें इस प्रकार बनाएँ:

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

फिर UI को अपने Gateway WS URL की ओर इंगित करें (उदा. `ws://127.0.0.1:18789`)।

## डिबगिंग/टेस्टिंग: dev सर्वर + रिमोट Gateway

कंट्रोल UI स्थिर फ़ाइलें हैं; WebSocket लक्ष्य विन्यस्त करने योग्य है और
HTTP origin से भिन्न हो सकता है। यह तब उपयोगी है जब आप Vite dev सर्वर लोकली चाहते हों
लेकिन Gateway कहीं और चल रहा हो।

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
- जब `gatewayUrl` सेट होता है, तो UI विन्यास या पर्यावरण क्रेडेंशियल्स पर फ़ॉलबैक नहीं करता।
  `token` (या `password`) स्पष्ट रूप से प्रदान करें। स्पष्ट क्रेडेंशियल्स का अभाव एक त्रुटि है।
- जब Gateway TLS (Tailscale Serve, HTTPS प्रॉक्सी, आदि) के पीछे हो, तो `wss://` का उपयोग करें।
- क्लिकजैकिंग रोकने के लिए `gatewayUrl` केवल टॉप‑लेवल विंडो में स्वीकार किया जाता है (एम्बेडेड नहीं)।
- क्रॉस‑ऑरिजिन dev सेटअप्स के लिए (उदा. `pnpm ui:dev` से रिमोट Gateway), UI
  origin को `gateway.controlUi.allowedOrigins` में जोड़ें।

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
