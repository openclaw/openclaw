---
summary: "Heartbeat पोलिंग संदेश और सूचना नियम"
read_when:
  - Heartbeat की आवृत्ति या संदेशों को समायोजित करते समय
  - अनुसूचित कार्यों के लिए Heartbeat और Cron के बीच निर्णय लेते समय
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat बनाम Cron?** प्रत्येक का उपयोग कब करना है, इसके लिए [Cron vs Heartbeat](/automation/cron-vs-heartbeat) देखें।

Heartbeat मुख्य सत्र में **आवधिक एजेंट टर्न** चलाता है, ताकि मॉडल बिना आपको स्पैम किए
ध्यान देने योग्य किसी भी चीज़ को सामने ला सके।

समस्या-निवारण: [/automation/troubleshooting](/automation/troubleshooting)

## त्वरित प्रारंभ (शुरुआती)

1. Heartbeat सक्षम रहने दें (डिफ़ॉल्ट `30m` है, या Anthropic OAuth/setup-token के लिए `1h`) या अपनी स्वयं की आवृत्ति सेट करें।
2. एजेंट वर्कस्पेस में एक छोटी `HEARTBEAT.md` चेकलिस्ट बनाएँ (वैकल्पिक, लेकिन अनुशंसित)।
3. तय करें कि Heartbeat संदेश कहाँ जाने चाहिए (`target: "last"` डिफ़ॉल्ट है)।
4. वैकल्पिक: पारदर्शिता के लिए Heartbeat reasoning डिलीवरी सक्षम करें।
5. वैकल्पिक: Heartbeat को सक्रिय घंटों तक सीमित करें (स्थानीय समय)।

उदाहरण विन्यास:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## डिफ़ॉल्ट

- Interval: `30m` (or `1h` when Anthropic OAuth/setup-token is the detected auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  Outside the window, heartbeats are skipped until the next tick inside the window.

## Heartbeat प्रॉम्प्ट का उद्देश्य

डिफ़ॉल्ट प्रॉम्प्ट जानबूझकर व्यापक है:

- **पृष्ठभूमि कार्य**: “Consider outstanding tasks” एजेंट को
  फ़ॉलो-अप (इनबॉक्स, कैलेंडर, रिमाइंडर, कतारबद्ध कार्य) की समीक्षा करने और किसी भी तात्कालिक चीज़ को सामने लाने के लिए प्रेरित करता है।
- **Human check-in**: “Checkup sometimes on your human during day time” nudges an
  occasional lightweight “anything you need?” message, but avoids night-time spam
  by using your configured local timezone (see [/concepts/timezone](/concepts/timezone)).

यदि आप चाहते हैं कि Heartbeat कुछ बहुत विशिष्ट करे (जैसे “check Gmail PubSub
stats” या “verify gateway health”), तो `agents.defaults.heartbeat.prompt` (या
`agents.list[].heartbeat.prompt`) को कस्टम बॉडी पर सेट करें (जैसा है वैसा भेजा जाएगा)।

## प्रतिक्रिया अनुबंध

- यदि किसी चीज़ पर ध्यान देने की आवश्यकता नहीं है, तो **`HEARTBEAT_OK`** के साथ उत्तर दें।
- During heartbeat runs, OpenClaw treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- यदि `HEARTBEAT_OK` उत्तर के **मध्य** में दिखाई देता है, तो इसे विशेष रूप से नहीं माना जाता।
- अलर्ट के लिए, **`HEARTBEAT_OK` शामिल न करें**; केवल अलर्ट पाठ लौटाएँ।

Heartbeat के बाहर, किसी संदेश के आरंभ/अंत में मौजूद अनचाहा `HEARTBEAT_OK` हटा दिया जाता है
और लॉग किया जाता है; जो संदेश केवल `HEARTBEAT_OK` होता है, उसे गिरा दिया जाता है।

## विन्यास

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### स्कोप और प्राथमिकता

- `agents.defaults.heartbeat` वैश्विक Heartbeat व्यवहार सेट करता है।
- `agents.list[].heartbeat` ऊपर से मर्ज होता है; यदि किसी भी एजेंट में `heartbeat` ब्लॉक है, तो **केवल वही एजेंट** Heartbeat चलाते हैं।
- `channels.defaults.heartbeat` सभी चैनलों के लिए दृश्यता डिफ़ॉल्ट सेट करता है।
- `channels.<channel>.heartbeat` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) overrides per-channel settings.

### प्रति-एजेंट Heartbeat

If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

उदाहरण: दो एजेंट, केवल दूसरा एजेंट Heartbeat चलाता है।

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### सक्रिय घंटे का उदाहरण

किसी विशिष्ट टाइमज़ोन में Heartbeat को व्यावसायिक घंटों तक सीमित करें:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. विंडो के अंदर अगला निर्धारित टिक सामान्य रूप से चलेगा।

### मल्टी-अकाउंट उदाहरण

Telegram जैसे मल्टी-अकाउंट चैनलों पर किसी विशिष्ट अकाउंट को लक्षित करने के लिए `accountId` का उपयोग करें:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### फ़ील्ड नोट्स

- `every`: Heartbeat अंतराल (अवधि स्ट्रिंग; डिफ़ॉल्ट इकाई = मिनट)।
- `model`: Heartbeat रन के लिए वैकल्पिक मॉडल ओवरराइड (`provider/model`)।
- `includeReasoning`: सक्षम होने पर, उपलब्ध होने पर अलग `Reasoning:` संदेश भी डिलीवर करता है (आकार `/reasoning on` जैसा ही)।
- `session`: Heartbeat रन के लिए वैकल्पिक सत्र कुंजी।
  - `main` (डिफ़ॉल्ट): एजेंट मुख्य सत्र।
  - स्पष्ट सत्र कुंजी (`openclaw sessions --json` या [sessions CLI](/cli/sessions) से कॉपी करें)।
  - सत्र कुंजी प्रारूप: [Sessions](/concepts/session) और [Groups](/channels/groups) देखें।
- `target`:
  - `last` (डिफ़ॉल्ट): अंतिम उपयोग किए गए बाहरी चैनल पर डिलीवर करें।
  - स्पष्ट चैनल: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`।
  - `none`: Heartbeat चलाएँ लेकिन **बाहरी रूप से डिलीवर न करें**।
- `to`: वैकल्पिक प्राप्तकर्ता ओवरराइड (चैनल-विशिष्ट आईडी, जैसे WhatsApp के लिए E.164 या Telegram चैट आईडी)।
- `accountId`: मल्टी-अकाउंट चैनलों के लिए वैकल्पिक अकाउंट आईडी। जब `target: "last"` हो, तो अकाउंट आईडी resolved अंतिम चैनल पर लागू होती है यदि वह अकाउंट्स को सपोर्ट करता है; अन्यथा इसे अनदेखा कर दिया जाता है। यदि अकाउंट आईडी resolved चैनल के लिए कॉन्फ़िगर किए गए किसी अकाउंट से मेल नहीं खाती, तो डिलीवरी स्किप कर दी जाती है।
- `prompt`: डिफ़ॉल्ट प्रॉम्प्ट बॉडी को ओवरराइड करता है (मर्ज नहीं किया जाता)।
- `ackMaxChars`: `HEARTBEAT_OK` के बाद डिलीवरी से पहले अनुमत अधिकतम वर्ण।
- `activeHours`: हार्टबीट रन को एक समय विंडो तक सीमित करता है। `start` (HH:MM, inclusive), `end` (HH:MM exclusive; दिन के अंत के लिए `24:00` अनुमत), और वैकल्पिक `timezone` के साथ ऑब्जेक्ट।
  - छोड़ा गया या `"user"`: यदि सेट है तो आपके `agents.defaults.userTimezone` का उपयोग करता है, अन्यथा होस्ट सिस्टम टाइमज़ोन पर वापस जाता है।
  - `"local"`: हमेशा होस्ट सिस्टम टाइमज़ोन का उपयोग करता है।
  - कोई भी IANA पहचानकर्ता (जैसे `America/New_York`): सीधे उपयोग किया जाता है; यदि अमान्य है, तो ऊपर दिए गए `"user"` व्यवहार पर वापस जाता है।
  - सक्रिय विंडो के बाहर, Heartbeat को विंडो के भीतर अगले टिक तक छोड़ा जाता है।

## डिलीवरी व्यवहार

- हार्टबीट्स डिफ़ॉल्ट रूप से एजेंट के मुख्य सत्र में चलते हैं (`agent:<id>:<mainKey>`),
  या `global` जब `session.scope = "global"` हो। `session` को सेट करके किसी
  विशिष्ट चैनल सत्र (Discord/WhatsApp/etc.) पर ओवरराइड करें।
- `session` केवल रन संदर्भ को प्रभावित करता है; डिलीवरी `target` और `to` द्वारा नियंत्रित होती है।
- किसी विशिष्ट चैनल/प्राप्तकर्ता को डिलीवर करने के लिए `target` + `to` सेट करें। `target: "last"` के साथ, डिलीवरी उस सत्र के लिए अंतिम बाहरी चैनल का उपयोग करती है।
- यदि मुख्य कतार व्यस्त है, तो Heartbeat छोड़ा जाता है और बाद में पुनः प्रयास किया जाता है।
- यदि `target` किसी बाहरी गंतव्य में हल नहीं होता, तो रन फिर भी होता है लेकिन कोई आउटबाउंड संदेश नहीं भेजा जाता।
- केवल Heartbeat प्रतिक्रियाएँ सत्र को जीवित **नहीं** रखतीं; अंतिम `updatedAt` पुनर्स्थापित किया जाता है ताकि निष्क्रिय समाप्ति सामान्य रूप से व्यवहार करे।

## दृश्यता नियंत्रण

डिफ़ॉल्ट रूप से, अलर्ट कंटेंट डिलीवर होने के दौरान `HEARTBEAT_OK` acknowledgments दबा दिए जाते हैं। आप इसे प्रति चैनल या प्रति अकाउंट समायोजित कर सकते हैं:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

प्राथमिकता: प्रति-अकाउंट → प्रति-चैनल → चैनल डिफ़ॉल्ट → अंतर्निहित डिफ़ॉल्ट।

### प्रत्येक फ़्लैग क्या करता है

- `showOk`: जब मॉडल केवल OK वाला उत्तर लौटाता है, तो `HEARTBEAT_OK` acknowledgment भेजता है।
- `showAlerts`: जब मॉडल गैर-OK उत्तर लौटाता है, तो अलर्ट सामग्री भेजता है।
- `useIndicator`: UI स्थिति सतहों के लिए संकेतक इवेंट उत्पन्न करता है।

यदि **तीनों** false हैं, तो OpenClaw Heartbeat रन को पूरी तरह छोड़ देता है (कोई मॉडल कॉल नहीं)।

### प्रति-चैनल बनाम प्रति-अकाउंट उदाहरण

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### सामान्य पैटर्न

| लक्ष्य                                                           | विन्यास                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| डिफ़ॉल्ट व्यवहार (मौन OKs, अलर्ट चालू)        | _(कोई विन्यास आवश्यक नहीं)_                                           |
| पूर्णतः मौन (कोई संदेश नहीं, कोई संकेतक नहीं) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| केवल संकेतक (कोई संदेश नहीं)                  | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| केवल एक चैनल में OKs                                             | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (वैकल्पिक)

यदि वर्कस्पेस में `HEARTBEAT.md` फ़ाइल मौजूद है, तो डिफ़ॉल्ट प्रॉम्प्ट एजेंट को इसे पढ़ने के लिए कहता है। इसे अपनी “हार्टबीट चेकलिस्ट” की तरह समझें: छोटी, स्थिर, और हर 30 मिनट में शामिल करने के लिए सुरक्षित।

यदि `HEARTBEAT.md` मौजूद है लेकिन प्रभावी रूप से खाली है (केवल खाली पंक्तियाँ और `# Heading` जैसे मार्कडाउन हेडर्स), तो OpenClaw API कॉल बचाने के लिए हार्टबीट रन स्किप कर देता है।
यदि फ़ाइल गायब है, तो हार्टबीट फिर भी चलता है और मॉडल तय करता है कि क्या करना है।

इसे छोटा रखें (संक्षिप्त चेकलिस्ट या रिमाइंडर) ताकि प्रॉम्प्ट फुलाव से बचा जा सके।

उदाहरण `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### क्या एजेंट HEARTBEAT.md को अपडेट कर सकता है?

हाँ — यदि आप उससे ऐसा करने को कहें।

`HEARTBEAT.md` एजेंट वर्कस्पेस में एक सामान्य फ़ाइल है, इसलिए आप एजेंट से (सामान्य चैट में) कुछ ऐसा कह सकते हैं:

- “दैनिक कैलेंडर जाँच जोड़ने के लिए `HEARTBEAT.md` अपडेट करें।”
- “`HEARTBEAT.md` को फिर से लिखें ताकि यह छोटा हो और इनबॉक्स फ़ॉलो-अप पर केंद्रित हो।”

यदि आप चाहते हैं कि यह सक्रिय रूप से हो, तो आप अपने Heartbeat प्रॉम्प्ट में एक स्पष्ट पंक्ति भी शामिल कर सकते हैं, जैसे: “यदि चेकलिस्ट पुरानी हो जाए, तो बेहतर वाली के साथ HEARTBEAT.md अपडेट करें।”

सुरक्षा नोट: `HEARTBEAT.md` में रहस्य (API कुंजियाँ, फ़ोन नंबर, निजी टोकन) न डालें — यह प्रॉम्प्ट संदर्भ का हिस्सा बन जाता है।

## मैनुअल वेक (ऑन-डिमांड)

आप एक सिस्टम इवेंट को कतार में डाल सकते हैं और तुरंत Heartbeat ट्रिगर कर सकते हैं:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

यदि कई एजेंटों में `heartbeat` कॉन्फ़िगर है, तो मैनुअल वेक उन सभी एजेंट Heartbeat को तुरंत चलाता है।

अगले निर्धारित टिक की प्रतीक्षा करने के लिए `--mode next-heartbeat` का उपयोग करें।

## Reasoning डिलीवरी (वैकल्पिक)

डिफ़ॉल्ट रूप से, Heartbeat केवल अंतिम “उत्तर” पेलोड डिलीवर करते हैं।

यदि आप पारदर्शिता चाहते हैं, तो सक्षम करें:

- `agents.defaults.heartbeat.includeReasoning: true`

सक्षम होने पर, हार्टबीट्स एक अलग संदेश भी डिलीवर करेंगे जिसका प्रीफ़िक्स `Reasoning:` होगा (आकार `/reasoning on` जैसा ही)। यह तब उपयोगी हो सकता है जब एजेंट कई सत्रों/कोडेक्स का प्रबंधन कर रहा हो और आप देखना चाहते हों कि उसने आपको पिंग करने का निर्णय क्यों लिया — लेकिन इससे आपकी अपेक्षा से अधिक आंतरिक विवरण लीक हो सकता है। ग्रुप चैट्स में इसे बंद रखना बेहतर है।

## लागत जागरूकता

हार्टबीट्स पूर्ण एजेंट टर्न्स चलाते हैं। छोटे इंटरवल अधिक टोकन खर्च करते हैं। `HEARTBEAT.md` को छोटा रखें और यदि आप केवल आंतरिक स्टेट अपडेट चाहते हैं तो सस्ता `model` या `target: "none"` पर विचार करें।
