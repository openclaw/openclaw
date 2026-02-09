---
summary: "Gateway शेड्यूलर के लिए Cron जॉब्स + वेकअप्स"
read_when:
  - बैकग्राउंड जॉब्स या वेकअप्स शेड्यूल करना
  - हार्टबीट के साथ या उसके समानांतर चलने वाली ऑटोमेशन को वायर करना
  - शेड्यूल्ड कार्यों के लिए हार्टबीट और क्रॉन के बीच निर्णय लेना
title: "Cron Jobs"
---

# Cron jobs (Gateway scheduler)

> **Cron बनाम Heartbeat?** प्रत्येक का उपयोग कब करना है, इसके लिए [Cron vs Heartbeat](/automation/cron-vs-heartbeat) देखें।

Cron Gateway का built-in scheduler है। यह jobs को persist करता है, सही समय पर agent को जगाता है, और वैकल्पिक रूप से output को किसी chat में वापस डिलीवर कर सकता है।

यदि आप _“इसे हर सुबह चलाओ”_ या _“20 मिनट में एजेंट को पोक करो”_ चाहते हैं, तो cron ही सही तंत्र है।

समस्या-निवारण: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron **Gateway के भीतर** चलता है (मॉडल के भीतर नहीं)।
- जॉब्स `~/.openclaw/cron/` के अंतर्गत स्थायी रहती हैं, इसलिए रीस्टार्ट से शेड्यूल नहीं खोते।
- दो निष्पादन शैलियाँ:
  - **Main session**: एक सिस्टम इवेंट को enqueue करें, फिर अगली हार्टबीट पर चलाएँ।
  - **Isolated**: `cron:<jobId>` में एक समर्पित एजेंट टर्न चलाएँ, डिलीवरी के साथ (डिफ़ॉल्ट रूप से announce या none)।
- Wakeups प्रथम-श्रेणी के हैं: कोई जॉब “अभी जगाओ” बनाम “अगली हार्टबीट” का अनुरोध कर सकता है।

## त्वरित प्रारंभ (कार्रवाई योग्य)

एक one-shot रिमाइंडर बनाएँ, उसके अस्तित्व की पुष्टि करें, और उसे तुरंत चलाएँ:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

डिलीवरी के साथ एक आवर्ती isolated जॉब शेड्यूल करें:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Tool-call equivalents (Gateway cron tool)

कैनोनिकल JSON शेप्स और उदाहरणों के लिए, [टूल कॉल्स के लिए JSON schema](/automation/cron-jobs#json-schema-for-tool-calls) देखें।

## Cron जॉब्स कहाँ संग्रहीत होती हैं

Cron jobs डिफ़ॉल्ट रूप से Gateway host पर `~/.openclaw/cron/jobs.json` में persist की जाती हैं।
Gateway फ़ाइल को memory में लोड करता है और बदलावों पर इसे वापस लिखता है, इसलिए manual edits केवल तब सुरक्षित हैं जब Gateway रुका हुआ हो। बदलावों के लिए `openclaw cron add/edit` या cron tool call API को प्राथमिकता दें।

## शुरुआती-अनुकूल अवलोकन

एक cron जॉब को ऐसे समझें: **कब** चलाना है + **क्या** करना है।

1. **शेड्यूल चुनें**
   - One-shot रिमाइंडर → `schedule.kind = "at"` (CLI: `--at`)
   - आवर्ती जॉब → `schedule.kind = "every"` या `schedule.kind = "cron"`
   - यदि आपके ISO टाइमस्टैम्प में टाइमज़ोन नहीं है, तो उसे **UTC** माना जाता है।

2. **कहाँ चलता है, चुनें**
   - `sessionTarget: "main"` → मुख्य कॉन्टेक्स्ट के साथ अगली हार्टबीट के दौरान चलाएँ।
   - `sessionTarget: "isolated"` → `cron:<jobId>` में एक समर्पित एजेंट टर्न चलाएँ।

3. **पेलोड चुनें**
   - Main session → `payload.kind = "systemEvent"`
   - Isolated session → `payload.kind = "agentTurn"`

वैकल्पिक: one-shot jobs (`schedule.kind = "at"`) सफलता के बाद डिफ़ॉल्ट रूप से delete हो जाती हैं। `deleteAfterRun: false` सेट करें ताकि उन्हें रखा जा सके (वे सफलता के बाद disable हो जाएँगी)।

## Concepts

### Jobs

एक cron जॉब एक संग्रहीत रिकॉर्ड होता है, जिसमें शामिल हैं:

- एक **schedule** (कब चलना चाहिए),
- एक **payload** (क्या करना चाहिए),
- वैकल्पिक **delivery mode** (announce या none)।
- वैकल्पिक **agent binding** (`agentId`): किसी विशिष्ट एजेंट के अंतर्गत जॉब चलाएँ; यदि
  अनुपस्थित या अज्ञात हो, तो Gateway डिफ़ॉल्ट एजेंट पर फ़ॉलबैक करता है।

Jobs की पहचान एक स्थिर `jobId` से होती है (CLI/Gateway APIs द्वारा उपयोग किया जाता है)।
Agent tool calls में `jobId` canonical है; compatibility के लिए legacy `id` स्वीकार किया जाता है।
One-shot jobs सफलता के बाद डिफ़ॉल्ट रूप से auto-delete हो जाती हैं; उन्हें रखने के लिए `deleteAfterRun: false` सेट करें।

### Schedules

Cron तीन प्रकार के शेड्यूल का समर्थन करता है:

- `at`: `schedule.at` (ISO 8601) के माध्यम से one-shot टाइमस्टैम्प।
- `every`: निश्चित अंतराल (ms)।
- `cron`: वैकल्पिक IANA टाइमज़ोन के साथ 5-फ़ील्ड cron अभिव्यक्ति।

Cron expressions `croner` का उपयोग करती हैं। यदि timezone छोड़ा गया हो, तो Gateway host का local timezone उपयोग किया जाता है।

### Main बनाम isolated निष्पादन

#### Main session जॉब्स (system events)

Main jobs एक system event enqueue करती हैं और वैकल्पिक रूप से heartbeat runner को जगाती हैं।
उन्हें `payload.kind = "systemEvent"` का उपयोग करना चाहिए।

- `wakeMode: "now"` (डिफ़ॉल्ट): इवेंट तुरंत हार्टबीट रन ट्रिगर करता है।
- `wakeMode: "next-heartbeat"`: इवेंट अगली शेड्यूल्ड हार्टबीट की प्रतीक्षा करता है।

जब आपको normal heartbeat prompt + main-session context चाहिए, तब यह सबसे उपयुक्त है।
देखें [Heartbeat](/gateway/heartbeat)।

#### Isolated जॉब्स (समर्पित cron सत्र)

Isolated जॉब्स सत्र `cron:<jobId>` में एक समर्पित एजेंट टर्न चलाती हैं।

मुख्य व्यवहार:

- ट्रेसबिलिटी के लिए प्रॉम्प्ट को `[cron:<jobId> <job name>]` से प्रीफ़िक्स किया जाता है।
- प्रत्येक रन एक **नया सत्र id** शुरू करता है (पूर्व वार्तालाप का कैरी-ओवर नहीं)।
- डिफ़ॉल्ट व्यवहार: यदि `delivery` छोड़ा गया है, तो isolated जॉब्स एक सारांश announce करती हैं (`delivery.mode = "announce"`)।
- `delivery.mode` (केवल isolated) यह चुनता है कि क्या होगा:
  - `announce`: लक्ष्य चैनल पर एक सारांश डिलीवर करें और main session में एक संक्षिप्त सारांश पोस्ट करें।
  - `none`: केवल आंतरिक (कोई डिलीवरी नहीं, कोई main-session सारांश नहीं)।
- `wakeMode` नियंत्रित करता है कि main-session सारांश कब पोस्ट होगा:
  - `now`: तुरंत हार्टबीट।
  - `next-heartbeat`: अगली शेड्यूल्ड हार्टबीट की प्रतीक्षा करता है।

Isolated जॉब्स का उपयोग शोरयुक्त, बार-बार चलने वाले, या “बैकग्राउंड कामों” के लिए करें जो
आपके मुख्य चैट इतिहास को स्पैम नहीं करने चाहिए।

### Payload shapes (क्या चलता है)

दो प्रकार के पेलोड समर्थित हैं:

- `systemEvent`: केवल main-session, हार्टबीट प्रॉम्प्ट के माध्यम से रूट किया जाता है।
- `agentTurn`: केवल isolated-session, एक समर्पित एजेंट टर्न चलाता है।

सामान्य `agentTurn` फ़ील्ड्स:

- `message`: आवश्यक टेक्स्ट प्रॉम्प्ट।
- `model` / `thinking`: वैकल्पिक ओवरराइड्स (नीचे देखें)।
- `timeoutSeconds`: वैकल्पिक टाइमआउट ओवरराइड।

डिलीवरी विन्यास (केवल isolated जॉब्स):

- `delivery.mode`: `none` | `announce`।
- `delivery.channel`: `last` या कोई विशिष्ट चैनल।
- `delivery.to`: चैनल-विशिष्ट लक्ष्य (फ़ोन/चैट/चैनल id)।
- `delivery.bestEffort`: यदि announce डिलीवरी विफल हो तो जॉब को विफल होने से बचाएँ।

Announce delivery उस run के लिए messaging tool sends को suppress करता है; इसके बजाय chat को target करने के लिए `delivery.channel`/`delivery.to` का उपयोग करें। जब `delivery.mode = "none"` हो, तो main session में कोई summary पोस्ट नहीं होती।

यदि isolated जॉब्स के लिए `delivery` छोड़ा गया है, तो OpenClaw डिफ़ॉल्ट रूप से `announce` सेट करता है।

#### Announce delivery प्रवाह

जब `delivery.mode = "announce"` हो, तो cron outbound channel adapters के माध्यम से सीधे deliver करता है।
Message को craft या forward करने के लिए main agent को spin up नहीं किया जाता।

व्यवहार विवरण:

- सामग्री: डिलीवरी isolated रन के आउटबाउंड पेलोड्स (टेक्स्ट/मीडिया) का उपयोग सामान्य चंकिंग और
  चैनल फ़ॉर्मैटिंग के साथ करती है।
- केवल हार्टबीट प्रतिक्रियाएँ (`HEARTBEAT_OK` बिना वास्तविक सामग्री के) डिलीवर नहीं की जातीं।
- यदि isolated रन ने पहले ही मैसेज टूल के माध्यम से उसी लक्ष्य पर संदेश भेज दिया है, तो डुप्लिकेट से बचने के लिए
  डिलीवरी स्किप कर दी जाती है।
- अनुपस्थित या अमान्य डिलीवरी लक्ष्य जॉब को विफल कर देते हैं, जब तक कि `delivery.bestEffort = true` न हो।
- एक छोटा सारांश main session में केवल तब पोस्ट होता है जब `delivery.mode = "announce"`।
- main-session सारांश `wakeMode` का सम्मान करता है: `now` तुरंत हार्टबीट ट्रिगर करता है और
  `next-heartbeat` अगली शेड्यूल्ड हार्टबीट की प्रतीक्षा करता है।

### Model और thinking ओवरराइड्स

Isolated जॉब्स (`agentTurn`) मॉडल और thinking स्तर को ओवरराइड कर सकती हैं:

- `model`: प्रदाता/मॉडल स्ट्रिंग (उदा., `anthropic/claude-sonnet-4-20250514`) या एलियास (उदा., `opus`)
- `thinking`: Thinking स्तर (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; केवल GPT-5.2 + Codex मॉडल)

नोट: आप main-session jobs पर भी `model` सेट कर सकते हैं, लेकिन यह shared main session model को बदल देता है। हम unexpected context shifts से बचने के लिए केवल isolated jobs के लिए model overrides की सिफ़ारिश करते हैं।

रिज़ॉल्यूशन प्राथमिकता:

1. जॉब पेलोड ओवरराइड (सबसे उच्च)
2. हुक-विशिष्ट डिफ़ॉल्ट्स (उदा., `hooks.gmail.model`)
3. एजेंट विन्यास डिफ़ॉल्ट

### Delivery (चैनल + लक्ष्य)

Isolated जॉब्स शीर्ष-स्तरीय `delivery` विन्यास के माध्यम से किसी चैनल पर आउटपुट डिलीवर कर सकती हैं:

- `delivery.mode`: `announce` (एक सारांश डिलीवर करें) या `none`।
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`।
- `delivery.to`: चैनल-विशिष्ट प्राप्तकर्ता लक्ष्य।

डिलीवरी विन्यास केवल isolated जॉब्स के लिए मान्य है (`sessionTarget: "isolated"`)।

यदि `delivery.channel` या `delivery.to` छोड़ा गया है, तो cron main session के
“last route” (जहाँ एजेंट ने आख़िरी बार उत्तर दिया) पर फ़ॉलबैक कर सकता है।

लक्ष्य फ़ॉर्मैट रिमाइंडर्स:

- Slack/Discord/Mattermost (plugin) लक्ष्यों को अस्पष्टता से बचने के लिए स्पष्ट प्रीफ़िक्स का उपयोग करना चाहिए (उदा., `channel:<id>`, `user:<id>`)।
- Telegram topics को `:topic:` फ़ॉर्म का उपयोग करना चाहिए (नीचे देखें)।

#### Telegram डिलीवरी लक्ष्य (topics / forum threads)

Telegram `message_thread_id` के माध्यम से forum topics को सपोर्ट करता है। Cron delivery के लिए, आप topic/thread को `to` field में encode कर सकते हैं:

- `-1001234567890` (केवल chat id)
- `-1001234567890:topic:123` (पसंदीदा: स्पष्ट topic मार्कर)
- `-1001234567890:123` (शॉर्टहैंड: संख्यात्मक प्रत्यय)

`telegram:...` / `telegram:group:...` जैसे प्रीफ़िक्स्ड लक्ष्य भी स्वीकार किए जाते हैं:

- `telegram:group:-1001234567890:topic:123`

## टूल कॉल्स के लिए JSON schema

Gateway `cron.*` tools को सीधे कॉल करते समय (agent tool calls या RPC) इन shapes का उपयोग करें।
CLI flags `20m` जैसी human durations स्वीकार करते हैं, लेकिन tool calls में `schedule.at` के लिए ISO 8601 string और `schedule.everyMs` के लिए milliseconds का उपयोग करना चाहिए।

### cron.add params

One-shot, main session जॉब (system event):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

आवर्ती, isolated जॉब डिलीवरी के साथ:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

टिप्पणियाँ:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), या `cron` (`expr`, वैकल्पिक `tz`)।
- `schedule.at` ISO 8601 स्वीकार करता है (टाइमज़ोन वैकल्पिक; छोड़े जाने पर UTC माना जाता है)।
- `everyMs` मिलीसेकंड है।
- `sessionTarget` को `"main"` या `"isolated"` होना चाहिए और इसे `payload.kind` से मेल खाना चाहिए।
- वैकल्पिक फ़ील्ड्स: `agentId`, `description`, `enabled`, `deleteAfterRun` (`at` के लिए डिफ़ॉल्ट true),
  `delivery`।
- `wakeMode` छोड़े जाने पर `"now"` पर डिफ़ॉल्ट होता है।

### cron.update params

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

टिप्पणियाँ:

- `jobId` कैनोनिकल है; संगतता के लिए `id` स्वीकार किया जाता है।
- किसी एजेंट बाइंडिंग को साफ़ करने के लिए पैच में `agentId: null` का उपयोग करें।

### cron.run और cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Storage & history

- जॉब स्टोर: `~/.openclaw/cron/jobs.json` (Gateway-प्रबंधित JSON)।
- रन इतिहास: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, स्वतः-प्रून)।
- स्टोर पथ ओवरराइड: विन्यास में `cron.store`।

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Cron को पूरी तरह अक्षम करें:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI त्वरित प्रारंभ

One-shot रिमाइंडर (UTC ISO, सफलता के बाद स्वतः हटता है):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

One-shot रिमाइंडर (main session, तुरंत जगाएँ):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

आवर्ती isolated जॉब (WhatsApp पर announce):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

आवर्ती isolated जॉब (Telegram topic पर डिलीवर):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

मॉडल और thinking ओवरराइड के साथ isolated जॉब:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

एजेंट चयन (multi-agent सेटअप्स):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

मैनुअल रन (force डिफ़ॉल्ट है; केवल due होने पर चलाने के लिए `--due` का उपयोग करें):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

मौजूदा जॉब संपादित करें (फ़ील्ड्स पैच करें):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

रन इतिहास:

```bash
openclaw cron runs --id <jobId> --limit 50
```

जॉब बनाए बिना तत्काल सिस्टम इवेंट:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API surface

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force या due), `cron.runs`
  जॉब के बिना तत्काल सिस्टम इवेंट्स के लिए, [`openclaw system event`](/cli/system) का उपयोग करें।

## Troubleshooting

### “कुछ भी नहीं चलता”

- जाँचें कि cron सक्षम है: `cron.enabled` और `OPENCLAW_SKIP_CRON`।
- जाँचें कि Gateway लगातार चल रहा है (cron Gateway प्रक्रिया के भीतर चलता है)।
- `cron` शेड्यूल्स के लिए: टाइमज़ोन (`--tz`) बनाम होस्ट टाइमज़ोन की पुष्टि करें।

### एक आवर्ती जॉब विफलताओं के बाद लगातार देर करती रहती है

- OpenClaw आवर्ती जॉब्स के लिए लगातार त्रुटियों के बाद एक्सपोनेंशियल रिट्राई बैकऑफ़ लागू करता है:
  30s, 1m, 5m, 15m, फिर रिट्राई के बीच 60m।
- अगली सफल रन के बाद बैकऑफ़ स्वतः रीसेट हो जाता है।
- One-shot (`at`) जॉब्स एक टर्मिनल रन (`ok`, `error`, या `skipped`) के बाद निष्क्रिय हो जाती हैं और रिट्राई नहीं करतीं।

### Telegram गलत जगह डिलीवर करता है

- फ़ोरम टॉपिक्स के लिए, इसे स्पष्ट और अस्पष्टता-रहित बनाने हेतु `-100…:topic:<id>` का उपयोग करें।
- यदि आपको लॉग्स या संग्रहीत “last route” लक्ष्यों में `telegram:...` प्रीफ़िक्स दिखाई दें, तो यह सामान्य है;
  cron डिलीवरी उन्हें स्वीकार करती है और फिर भी topic IDs को सही ढंग से पार्स करती है।
