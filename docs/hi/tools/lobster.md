---
title: Lobster
summary: "OpenClaw के लिए पुनःआरंभ योग्य अनुमोदन गेट्स के साथ टाइप्ड वर्कफ़्लो रनटाइम।"
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - आप स्पष्ट अनुमोदनों के साथ निर्धारक बहु-चरण वर्कफ़्लो चाहते हैं
  - आपको पहले के चरणों को दोबारा चलाए बिना वर्कफ़्लो पुनःआरंभ करने की आवश्यकता है
---

# Lobster

Lobster एक वर्कफ़्लो शेल है जो OpenClaw को स्पष्ट अनुमोदन चेकपॉइंट्स के साथ बहु-चरण टूल अनुक्रमों को एक एकल, निर्धारक ऑपरेशन के रूप में चलाने देता है।

## Hook

आपका असिस्टेंट उन टूल्स का निर्माण कर सकता है जो स्वयं को प्रबंधित करते हैं। एक वर्कफ़्लो के लिए पूछें, और 30 मिनट बाद आपके पास एक CLI होगा साथ ही पाइपलाइन्स होंगी जो एक कॉल में चलती हैं। Lobster वह गायब हिस्सा है: निर्धारक पाइपलाइन्स, स्पष्ट अनुमोदन, और पुनः आरंभ करने योग्य स्थिति।

## Why

आज, जटिल वर्कफ़्लोज़ के लिए कई आगे-पीछे टूल कॉल्स की आवश्यकता होती है। हर कॉल टोकन खर्च करती है, और LLM को हर चरण का ऑर्केस्ट्रेशन करना पड़ता है। Lobster उस ऑर्केस्ट्रेशन को एक टाइप्ड रनटाइम में स्थानांतरित करता है:

- **कई के बजाय एक कॉल**: OpenClaw एक Lobster टूल कॉल चलाता है और एक संरचित परिणाम प्राप्त करता है।
- **अंतर्निहित अनुमोदन**: साइड इफेक्ट्स (ईमेल भेजना, टिप्पणी पोस्ट करना) तब तक वर्कफ़्लो को रोकते हैं जब तक स्पष्ट रूप से अनुमोदित न हों।
- **पुनःआरंभ योग्य**: रुके हुए वर्कफ़्लो एक टोकन लौटाते हैं; सब कुछ दोबारा चलाए बिना अनुमोदन दें और पुनःआरंभ करें।

## साधारण प्रोग्राम्स की बजाय DSL क्यों?

Lobster जानबूझकर छोटा रखा गया है। लक्ष्य "एक नई भाषा" नहीं है; यह एक पूर्वानुमेय, AI-फ्रेंडली पाइपलाइन स्पेसिफिकेशन है जिसमें फर्स्ट-क्लास अनुमोदन और रिज़्यूम टोकन्स हैं।

- **अनुमोदन/रिज़्यूम अंतर्निहित**: एक सामान्य प्रोग्राम किसी मानव से पूछ सकता है, लेकिन बिना खुद वह रनटाइम बनाए _रोकना और पुनःआरंभ_ नहीं कर सकता।
- **निर्धारकता + ऑडिटेबिलिटी**: पाइपलाइंस डेटा हैं, इसलिए उन्हें लॉग, डिफ़, रीप्ले और रिव्यू करना आसान है।
- **AI के लिए सीमित सतह**: छोटा व्याकरण + JSON पाइपिंग “रचनात्मक” कोड पाथ्स को घटाती है और वैलिडेशन को यथार्थवादी बनाती है।
- **सुरक्षा नीति अंतर्निहित**: टाइमआउट्स, आउटपुट कैप्स, sandbox चेक्स और allowlists रनटाइम द्वारा लागू होते हैं, न कि हर स्क्रिप्ट द्वारा।
- **फिर भी प्रोग्रामेबल**: प्रत्येक चरण किसी भी CLI या स्क्रिप्ट को कॉल कर सकता है। यदि आप JS/TS चाहते हैं, तो कोड से `.lobster` फ़ाइलें जनरेट करें।

## How it works

OpenClaw स्थानीय `lobster` CLI को **टूल मोड** में लॉन्च करता है और stdout से एक JSON एनवेलप पार्स करता है।
यदि पाइपलाइन अनुमोदन के लिए रुकती है, तो टूल एक `resumeToken` लौटाता है ताकि आप बाद में जारी रख सकें।

## Pattern: छोटा CLI + JSON पाइप्स + अनुमोदन

छोटे कमांड बनाएं जो JSON बोलते हों, फिर उन्हें एक ही Lobster कॉल में चेन करें। (नीचे उदाहरण कमांड नाम दिए गए हैं — अपनी पसंद के नामों से बदलें।)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

यदि पाइपलाइन अनुमोदन का अनुरोध करती है, तो टोकन के साथ पुनःआरंभ करें:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI वर्कफ़्लो को ट्रिगर करता है; Lobster चरणों को निष्पादित करता है। अनुमोदन गेट्स साइड इफ़ेक्ट्स को स्पष्ट और ऑडिटेबल रखते हैं।

उदाहरण: इनपुट आइटम्स को टूल कॉल्स में मैप करना:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## केवल‑JSON LLM चरण (llm-task)

**संरचित LLM चरण** की आवश्यकता वाले वर्कफ़्लोज़ के लिए, वैकल्पिक `llm-task` प्लगइन टूल सक्षम करें और उसे Lobster से कॉल करें। यह वर्कफ़्लो को निर्धारक बनाए रखता है, जबकि फिर भी आपको मॉडल के साथ वर्गीकरण/सारांश/ड्राफ्ट करने देता है।

टूल सक्षम करें:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

पाइपलाइन में उपयोग करें:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

विवरण और विन्यास विकल्पों के लिए [LLM Task](/tools/llm-task) देखें।

## वर्कफ़्लो फ़ाइलें (.lobster)

Lobster `name`, `args`, `steps`, `env`, `condition`, और `approval` फ़ील्ड्स के साथ YAML/JSON वर्कफ़्लो फ़ाइलें चला सकता है। OpenClaw टूल कॉल्स में, `pipeline` को फ़ाइल पाथ पर सेट करें।

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

नोट्स:

- `stdin: $step.stdout` और `stdin: $step.json` किसी पूर्व चरण के आउटपुट को पास करते हैं।
- `condition` (या `when`) चरणों को `$step.approved` पर गेट कर सकता है।

## Install Lobster

OpenClaw Gateway चलाने वाले **उसी होस्ट** पर Lobster CLI इंस्टॉल करें (देखें [Lobster repo](https://github.com/openclaw/lobster)), और सुनिश्चित करें कि `lobster` `PATH` पर हो।
यदि आप कस्टम बाइनरी लोकेशन का उपयोग करना चाहते हैं, तो टूल कॉल में **absolute** `lobsterPath` पास करें।

## टूल सक्षम करें

Lobster एक **वैकल्पिक** प्लगइन टूल है (डिफ़ॉल्ट रूप से सक्षम नहीं)।

अनुशंसित (एडिटिव, सुरक्षित):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

या प्रति‑एजेंट:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

`tools.allow: ["lobster"]` का उपयोग तब तक न करें जब तक आप प्रतिबंधात्मक allowlist मोड में चलाने का इरादा न रखते हों।

नोट: allowlists वैकल्पिक प्लगइन्स के लिए opt-in होते हैं। यदि आपकी allowlist केवल
plugin टूल्स (जैसे `lobster`) का नाम देती है, तो OpenClaw core टूल्स को सक्षम रखता है। core
टूल्स को सीमित करने के लिए, जिन core टूल्स या समूहों की आपको आवश्यकता है उन्हें allowlist में भी शामिल करें।

## उदाहरण: ईमेल ट्रायेज

Lobster के बिना:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Lobster के साथ:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

एक JSON एनवेलप लौटता है (संक्षिप्त):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

उपयोगकर्ता अनुमोदन देता है → पुनःआरंभ:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

एक workflow। निर्धारक (Deterministic)। सुरक्षित।

## टूल पैरामीटर्स

### `run`

tool mode में एक पाइपलाइन चलाएँ।

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

आर्ग्स के साथ वर्कफ़्लो फ़ाइल चलाएँ:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

अनुमोदन के बाद रुके हुए वर्कफ़्लो को जारी रखें।

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### वैकल्पिक इनपुट्स

- `lobsterPath`: Lobster बाइनरी का absolute पथ (छोड़ने पर `PATH` उपयोग होगा)।
- `cwd`: पाइपलाइन के लिए वर्किंग डायरेक्टरी (डिफ़ॉल्ट: वर्तमान प्रोसेस वर्किंग डायरेक्टरी)।
- `timeoutMs`: यदि सबप्रोसेस इस अवधि से अधिक हो जाए तो उसे किल करें (डिफ़ॉल्ट: 20000)।
- `maxStdoutBytes`: यदि stdout इस आकार से अधिक हो जाए तो सबप्रोसेस किल करें (डिफ़ॉल्ट: 512000)।
- `argsJson`: `lobster run --args-json` को पास की गई JSON स्ट्रिंग (केवल वर्कफ़्लो फ़ाइलें)।

## आउटपुट एनवेलप

Lobster तीन में से एक स्थिति के साथ एक JSON एनवेलप लौटाता है:

- `ok` → सफलतापूर्वक पूर्ण
- `needs_approval` → रुका हुआ; पुनःआरंभ के लिए `requiresApproval.resumeToken` आवश्यक
- `cancelled` → स्पष्ट रूप से अस्वीकृत या रद्द

टूल एनवेलप को `content` (pretty JSON) और `details` (raw object) दोनों में प्रस्तुत करता है।

## अनुमोदन

यदि `requiresApproval` मौजूद है, तो प्रॉम्प्ट की जाँच करें और निर्णय लें:

- `approve: true` → पुनःआरंभ करें और साइड इफेक्ट्स जारी रखें
- `approve: false` → रद्द करें और वर्कफ़्लो को अंतिम रूप दें

`approve --preview-from-stdin --limit N` का उपयोग करें ताकि custom jq/heredoc glue के बिना approval requests में JSON preview संलग्न किया जा सके। Resume tokens अब compact हैं: Lobster अपने state dir के अंतर्गत workflow resume state स्टोर करता है और एक छोटा token key वापस देता है।

## OpenProse

OpenProse, Lobster के साथ अच्छी तरह काम करता है: multi-agent prep को orchestrate करने के लिए `/prose` का उपयोग करें, फिर deterministic approvals के लिए Lobster pipeline चलाएँ। यदि किसी Prose प्रोग्राम को Lobster चाहिए, तो `tools.subagents.tools` के माध्यम से sub-agents के लिए `lobster` टूल को allow करें। देखें [OpenProse](/prose)।

## Safety

- **केवल स्थानीय सबप्रोसेस** — प्लगइन स्वयं से कोई नेटवर्क कॉल नहीं।
- **कोई सीक्रेट्स नहीं** — Lobster OAuth प्रबंधित नहीं करता; यह OpenClaw टूल्स को कॉल करता है जो करते हैं।
- **Sandbox‑aware** — टूल कॉन्टेक्स्ट sandboxed होने पर अक्षम।
- **Hardened** — यदि निर्दिष्ट हो तो `lobsterPath` absolute होना चाहिए; टाइमआउट्स और आउटपुट कैप्स लागू।

## Troubleshooting

- **`lobster subprocess timed out`** → `timeoutMs` बढ़ाएँ, या लंबी पाइपलाइन को विभाजित करें।
- **`lobster output exceeded maxStdoutBytes`** → `maxStdoutBytes` बढ़ाएँ या आउटपुट आकार घटाएँ।
- **`lobster returned invalid JSON`** → सुनिश्चित करें कि पाइपलाइन tool mode में चलती है और केवल JSON प्रिंट करती है।
- **`lobster failed (code …)`** → stderr की जाँच के लिए उसी पाइपलाइन को टर्मिनल में चलाएँ।

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## केस स्टडी: समुदाय वर्कफ़्लो

एक सार्वजनिक उदाहरण: एक “second brain” CLI + Lobster pipelines जो तीन Markdown vaults (personal, partner, shared) को प्रबंधित करते हैं। CLI stats, inbox listings, और stale scans के लिए JSON emit करता है; Lobster उन कमांड्स को `weekly-review`, `inbox-triage`, `memory-consolidation`, और `shared-task-sync` जैसे workflows में chain करता है, प्रत्येक में approval gates के साथ। AI उपलब्ध होने पर judgment (categorization) संभालता है और उपलब्ध न होने पर deterministic rules पर वापस जाता है।

- थ्रेड: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- रिपो: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
