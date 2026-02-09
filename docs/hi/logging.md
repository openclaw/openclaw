---
summary: "लॉगिंग का अवलोकन: फ़ाइल लॉग्स, कंसोल आउटपुट, CLI टेलिंग, और Control UI"
read_when:
  - आपको लॉगिंग का शुरुआती-अनुकूल अवलोकन चाहिए
  - आप लॉग स्तरों या फ़ॉर्मैट्स को कॉन्फ़िगर करना चाहते हैं
  - आप समस्या-निवारण कर रहे हैं और लॉग्स जल्दी ढूँढने की ज़रूरत है
title: "लॉगिंग"
---

# लॉगिंग

OpenClaw दो स्थानों पर लॉग करता है:

- **फ़ाइल लॉग्स** (JSON lines), जिन्हें Gateway लिखता है।
- **कंसोल आउटपुट**, जो टर्मिनलों और Control UI में दिखता है।

यह पृष्ठ बताता है कि लॉग कहाँ रहते हैं, उन्हें कैसे पढ़ें, और लॉग
स्तरों व फ़ॉर्मैट्स को कैसे कॉन्फ़िगर करें।

## लॉग कहाँ रहते हैं

डिफ़ॉल्ट रूप से, Gateway एक रोलिंग लॉग फ़ाइल यहाँ लिखता है:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

तारीख Gateway होस्ट के स्थानीय टाइमज़ोन का उपयोग करती है।

आप इसे `~/.openclaw/openclaw.json` में ओवरराइड कर सकते हैं:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## लॉग कैसे पढ़ें

### CLI: लाइव टेल (अनुशंसित)

RPC के माध्यम से Gateway लॉग फ़ाइल को टेल करने के लिए CLI का उपयोग करें:

```bash
openclaw logs --follow
```

आउटपुट मोड्स:

- **TTY सत्र**: सुंदर, रंगीन, संरचित लॉग पंक्तियाँ।
- **नॉन‑TTY सत्र**: सादा टेक्स्ट।
- `--json`: लाइन‑डिलिमिटेड JSON (प्रति लाइन एक लॉग इवेंट)।
- `--plain`: TTY सत्रों में सादा टेक्स्ट मजबूर करें।
- `--no-color`: ANSI रंग अक्षम करें।

JSON मोड में, CLI `type`‑टैग किए गए ऑब्जेक्ट्स उत्सर्जित करता है:

- `meta`: स्ट्रीम मेटाडेटा (फ़ाइल, कर्सर, आकार)
- `log`: पार्स की गई लॉग एंट्री
- `notice`: ट्रंकेशन / रोटेशन संकेत
- `raw`: अनपार्स्ड लॉग पंक्ति

यदि Gateway पहुँच योग्य नहीं है, तो CLI यह चलाने के लिए एक छोटा संकेत प्रिंट करता है:

```bash
openclaw doctor
```

### Control UI (वेब)

कंट्रोल UI का **Logs** टैब `logs.tail` का उपयोग करके उसी फ़ाइल को tail करता है।
इसे कैसे खोलें, इसके लिए [/web/control-ui](/web/control-ui) देखें।

### केवल‑चैनल लॉग्स

चैनल गतिविधि (WhatsApp/Telegram/आदि) फ़िल्टर करने के लिए, उपयोग करें:

```bash
openclaw channels logs --channel whatsapp
```

## लॉग फ़ॉर्मैट्स

### फ़ाइल लॉग्स (JSONL)

लॉग फ़ाइल की प्रत्येक पंक्ति एक JSON ऑब्जेक्ट होती है। CLI और कंट्रोल UI इन प्रविष्टियों को पार्स करके संरचित आउटपुट (time, level, subsystem, message) रेंडर करते हैं।

### कंसोल आउटपुट

कंसोल लॉग्स **TTY‑aware** होते हैं और पठनीयता के लिए फ़ॉर्मैट किए जाते हैं:

- Subsystem prefixes (उदा. `gateway/channels/whatsapp`)
- स्तर रंगांकन (info/warn/error)
- वैकल्पिक कॉम्पैक्ट या JSON मोड

कंसोल फ़ॉर्मैटिंग `logging.consoleStyle` द्वारा नियंत्रित होती है।

## लॉगिंग का कॉन्फ़िगरेशन

सभी लॉगिंग कॉन्फ़िगरेशन `~/.openclaw/openclaw.json` में `logging` के अंतर्गत रहती हैं।

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### लॉग स्तर

- `logging.level`: **फ़ाइल लॉग्स** (JSONL) स्तर।
- `logging.consoleLevel`: **कंसोल** वर्बोसिटी स्तर।

`--verbose` केवल कंसोल आउटपुट को प्रभावित करता है; यह फ़ाइल लॉग स्तरों को नहीं बदलता।

### कंसोल शैलियाँ

`logging.consoleStyle`:

- `pretty`: मानव‑अनुकूल, रंगीन, टाइमस्टैम्प्स के साथ।
- `compact`: कसा हुआ आउटपुट (लंबे सत्रों के लिए सर्वोत्तम)।
- `json`: प्रति पंक्ति JSON (लॉग प्रोसेसरों के लिए)।

### रेडैक्शन

टूल सारांश संवेदनशील टोकन को कंसोल तक पहुँचने से पहले रेडैक्ट कर सकते हैं:

- `logging.redactSensitive`: `off` | `tools` (डिफ़ॉल्ट: `tools`)
- `logging.redactPatterns`: डिफ़ॉल्ट सेट को ओवरराइड करने के लिए regex स्ट्रिंग्स की सूची

रेडैक्शन केवल **कंसोल आउटपुट** को प्रभावित करता है और फ़ाइल लॉग्स में बदलाव नहीं करता।

## डायग्नोस्टिक्स + OpenTelemetry

Diagnostics मॉडल रन **और** message-flow telemetry (webhooks, queueing, session state) के लिए संरचित, machine-readable events होते हैं। ये **logs** को प्रतिस्थापित नहीं करते; ये metrics, traces और अन्य exporters को फ़ीड करने के लिए मौजूद होते हैं।

डायग्नोस्टिक्स इवेंट्स इन‑प्रोसेस उत्सर्जित होते हैं, लेकिन एक्सपोर्टर्स तभी अटैच होते हैं जब
डायग्नोस्टिक्स + एक्सपोर्टर प्लगइन सक्षम हों।

### OpenTelemetry बनाम OTLP

- **OpenTelemetry (OTel)**: ट्रेसेज़, मेट्रिक्स और लॉग्स के लिए डेटा मॉडल + SDKs।
- **OTLP**: OTel डेटा को कलेक्टर/बैकएंड तक एक्सपोर्ट करने के लिए उपयोग किया जाने वाला वायर प्रोटोकॉल।
- OpenClaw आज **OTLP/HTTP (protobuf)** के माध्यम से एक्सपोर्ट करता है।

### एक्सपोर्ट किए गए सिग्नल्स

- **मेट्रिक्स**: काउंटर + हिस्टोग्राम (टोकन उपयोग, मैसेज फ़्लो, क्यूइंग)।
- **ट्रेसेज़**: मॉडल उपयोग + वेबहुक/मैसेज प्रोसेसिंग के लिए स्पैन।
- **Logs**: जब `diagnostics.otel.logs` सक्षम होता है, तब OTLP के माध्यम से export किए जाते हैं। लॉग वॉल्यूम अधिक हो सकता है; `logging.level` और exporter filters को ध्यान में रखें।

### डायग्नोस्टिक इवेंट कैटलॉग

मॉडल उपयोग:

- `model.usage`: टोकन, लागत, अवधि, कॉन्टेक्स्ट, प्रदाता/मॉडल/चैनल, सत्र IDs।

मैसेज फ़्लो:

- `webhook.received`: प्रति चैनल वेबहुक इनग्रे़स।
- `webhook.processed`: वेबहुक हैंडल्ड + अवधि।
- `webhook.error`: वेबहुक हैंडलर त्रुटियाँ।
- `message.queued`: प्रोसेसिंग के लिए संदेश एन्क्यू किया गया।
- `message.processed`: परिणाम + अवधि + वैकल्पिक त्रुटि।

क्यू + सत्र:

- `queue.lane.enqueue`: कमांड क्यू लेन एन्क्यू + गहराई।
- `queue.lane.dequeue`: कमांड क्यू लेन डीक्यू + प्रतीक्षा समय।
- `session.state`: सत्र स्थिति संक्रमण + कारण।
- `session.stuck`: सत्र अटका चेतावनी + आयु।
- `run.attempt`: रन रीट्राई/प्रयास मेटाडेटा।
- `diagnostic.heartbeat`: समेकित काउंटर (वेबहुक्स/क्यू/सत्र)।

### डायग्नोस्टिक्स सक्षम करें (बिना एक्सपोर्टर)

यदि आप चाहते हैं कि डायग्नोस्टिक इवेंट्स प्लगइन्स या कस्टम सिंक्स के लिए उपलब्ध हों, तो इसका उपयोग करें:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### डायग्नोस्टिक्स फ़्लैग्स (लक्षित लॉग्स)

`logging.level` बढ़ाए बिना अतिरिक्त, लक्षित debug logs चालू करने के लिए flags का उपयोग करें।
Flags case-insensitive होते हैं और wildcards को सपोर्ट करते हैं (उदा. `telegram.*` या `*`)।

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Env ओवरराइड (एक‑बार):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

नोट्स:

- फ़्लैग लॉग्स मानक लॉग फ़ाइल में जाते हैं (जैसे `logging.file`)।
- आउटपुट अभी भी `logging.redactSensitive` के अनुसार रेडैक्ट किया जाता है।
- पूर्ण मार्गदर्शिका: [/diagnostics/flags](/diagnostics/flags)।

### OpenTelemetry में एक्सपोर्ट करें

Diagnostics को `diagnostics-otel` प्लगइन (OTLP/HTTP) के माध्यम से export किया जा सकता है। यह किसी भी ऐसे OpenTelemetry collector/backend के साथ काम करता है जो OTLP/HTTP स्वीकार करता हो।

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

नोट्स:

- आप प्लगइन को `openclaw plugins enable diagnostics-otel` के साथ भी सक्षम कर सकते हैं।
- `protocol` वर्तमान में केवल `http/protobuf` को सपोर्ट करता है। `grpc` को अनदेखा किया जाता है।
- मेट्रिक्स में टोकन उपयोग, लागत, कॉन्टेक्स्ट आकार, रन अवधि, और मैसेज‑फ़्लो
  काउंटर/हिस्टोग्राम (वेबहुक्स, क्यूइंग, सत्र स्थिति, क्यू गहराई/प्रतीक्षा) शामिल हैं।
- Traces/metrics को `traces` / `metrics` के साथ toggle किया जा सकता है (default: on)। Traces में सक्षम होने पर model usage spans के साथ webhook/message processing spans शामिल होते हैं।
- जब आपके कलेक्टर को प्रमाणीकरण चाहिए हो तो `headers` सेट करें।
- समर्थित पर्यावरण चर: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`।

### एक्सपोर्ट किए गए मेट्रिक्स (नाम + प्रकार)

मॉडल उपयोग:

- `openclaw.tokens` (काउंटर, गुण: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (काउंटर, गुण: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (हिस्टोग्राम, गुण: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (हिस्टोग्राम, गुण: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

मैसेज फ़्लो:

- `openclaw.webhook.received` (काउंटर, गुण: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (काउंटर, गुण: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (हिस्टोग्राम, गुण: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (काउंटर, गुण: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (काउंटर, गुण: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (हिस्टोग्राम, गुण: `openclaw.channel`,
  `openclaw.outcome`)

क्यू + सत्र:

- `openclaw.queue.lane.enqueue` (काउंटर, गुण: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (काउंटर, गुण: `openclaw.lane`)
- `openclaw.queue.depth` (हिस्टोग्राम, गुण: `openclaw.lane` या
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (हिस्टोग्राम, गुण: `openclaw.lane`)
- `openclaw.session.state` (काउंटर, गुण: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (काउंटर, गुण: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (हिस्टोग्राम, गुण: `openclaw.state`)
- `openclaw.run.attempt` (काउंटर, गुण: `openclaw.attempt`)

### एक्सपोर्ट किए गए स्पैन (नाम + प्रमुख गुण)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### सैंपलिंग + फ़्लशिंग

- ट्रेस सैंपलिंग: `diagnostics.otel.sampleRate` (0.0–1.0, केवल रूट स्पैन)।
- मेट्रिक एक्सपोर्ट अंतराल: `diagnostics.otel.flushIntervalMs` (न्यूनतम 1000ms)।

### प्रोटोकॉल नोट्स

- OTLP/HTTP एंडपॉइंट्स `diagnostics.otel.endpoint` या
  `OTEL_EXPORTER_OTLP_ENDPOINT` के माध्यम से सेट किए जा सकते हैं।
- यदि एंडपॉइंट में पहले से `/v1/traces` या `/v1/metrics` शामिल है, तो उसे जैसा‑का‑तैसा उपयोग किया जाता है।
- यदि एंडपॉइंट में पहले से `/v1/logs` शामिल है, तो लॉग्स के लिए उसे जैसा‑का‑तैसा उपयोग किया जाता है।
- `diagnostics.otel.logs` मुख्य लॉगर आउटपुट के लिए OTLP लॉग एक्सपोर्ट सक्षम करता है।

### लॉग एक्सपोर्ट व्यवहार

- OTLP लॉग्स वही संरचित रिकॉर्ड्स उपयोग करते हैं जो `logging.file` में लिखे जाते हैं।
- `logging.level` (file log level) का सम्मान करें। Console redaction OTLP logs पर **लागू नहीं** होती।
- उच्च‑वॉल्यूम इंस्टॉलेशन्स को OTLP कलेक्टर सैंपलिंग/फ़िल्टरिंग को प्राथमिकता देनी चाहिए।

## समस्या‑निवारण सुझाव

- **Gateway पहुँच योग्य नहीं?** पहले `openclaw doctor` चलाएँ।
- **लॉग्स खाली?** जाँचें कि Gateway चल रहा है और `logging.file` में दिए गए फ़ाइल पाथ पर लिख रहा है।
- **और विवरण चाहिए?** `logging.level` को `debug` या `trace` पर सेट करें और पुनः प्रयास करें।
