---
summary: "इनबाउंड ऑटो-रिप्लाई रन को क्रमबद्ध करने वाला कमांड क्यू डिज़ाइन"
read_when:
  - ऑटो-रिप्लाई निष्पादन या समांतरता बदलते समय
title: "कमांड क्यू"
---

# कमांड क्यू (2026-01-16)

हम कई एजेंट रन के टकराने से बचाने के लिए (सभी चैनलों पर) इनबाउंड ऑटो-रिप्लाई रन को एक छोटे इन-प्रोसेस क्यू के माध्यम से क्रमबद्ध करते हैं, जबकि सत्रों के बीच सुरक्षित समांतरता की अनुमति बनी रहती है।

## क्यों

- ऑटो-रिप्लाई रन महंगे हो सकते हैं (LLM कॉल) और जब कई इनबाउंड संदेश लगभग एक साथ आते हैं तो टकराव हो सकता है।
- क्रमबद्ध करना साझा संसाधनों (सत्र फ़ाइलें, लॉग्स, CLI stdin) के लिए प्रतिस्पर्धा से बचाता है और अपस्ट्रीम रेट लिमिट्स की संभावना कम करता है।

## यह कैसे काम करता है

- लेन-आधारित FIFO क्यू प्रत्येक लेन को एक विन्येय समांतरता सीमा के साथ ड्रेन करता है (अनकॉन्फ़िगर लेन के लिए डिफ़ॉल्ट 1; main के लिए डिफ़ॉल्ट 4, subagent के लिए 8)।
- `runEmbeddedPiAgent` **session key** (लेन `session:<key>`) के आधार पर एन्क्यू करता है ताकि प्रति सत्र केवल एक सक्रिय रन सुनिश्चित हो।
- प्रत्येक सत्र रन को फिर एक **global lane** (डिफ़ॉल्ट रूप से `main`) में क्यू किया जाता है ताकि कुल समांतरता `agents.defaults.maxConcurrent` द्वारा सीमित रहे।
- जब verbose लॉगिंग सक्षम होती है, तो क्यू में पड़े रन यदि शुरू होने से पहले ~2s से अधिक प्रतीक्षा करते हैं तो एक छोटा नोटिस उत्सर्जित करते हैं।
- टाइपिंग इंडिकेटर एन्क्यू पर तुरंत ट्रिगर होते हैं (जब चैनल द्वारा समर्थित हो), इसलिए अपनी बारी की प्रतीक्षा करते समय उपयोगकर्ता अनुभव अपरिवर्तित रहता है।

## क्यू मोड (प्रति चैनल)

इनबाउंड संदेश वर्तमान रन को स्टियर कर सकते हैं, फॉलोअप टर्न की प्रतीक्षा कर सकते हैं, या दोनों कर सकते हैं:

- `steer`: inject immediately into the current run (cancels pending tool calls after the next tool boundary). If not streaming, falls back to followup.
- `followup`: वर्तमान रन समाप्त होने के बाद अगले एजेंट टर्न के लिए एन्क्यू करें।
- `collect`: coalesce all queued messages into a **single** followup turn (default). If messages target different channels/threads, they drain individually to preserve routing.
- `steer-backlog` (उर्फ `steer+backlog`): अभी स्टियर करें **और** फॉलोअप टर्न के लिए संदेश सुरक्षित रखें।
- `interrupt` (लीगेसी): उस सत्र के सक्रिय रन को निरस्त करें, फिर नवीनतम संदेश चलाएँ।
- `queue` (लीगेसी उपनाम): `steer` के समान।

Steer-backlog means you can get a followup response after the steered run, so
streaming surfaces can look like duplicates. Prefer `collect`/`steer` if you want
one response per inbound message.
Send `/queue collect` as a standalone command (per-session) or set `messages.queue.byChannel.discord: "collect"`.

डिफ़ॉल्ट (जब कॉन्फ़िग में सेट न हो):

- सभी सतहें → `collect`

`messages.queue` के माध्यम से वैश्विक रूप से या प्रति चैनल कॉन्फ़िगर करें:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## क्यू विकल्प

विकल्प `followup`, `collect`, और `steer-backlog` पर लागू होते हैं (और `steer` पर भी जब वह फॉलोअप पर फ़ॉलबैक करता है):

- `debounceMs`: फॉलोअप टर्न शुरू करने से पहले शांति की प्रतीक्षा करें (“continue, continue” को रोकता है)।
- `cap`: प्रति सत्र अधिकतम क्यू किए गए संदेश।
- `drop`: ओवरफ़्लो नीति (`old`, `new`, `summarize`)।

Summarize keeps a short bullet list of dropped messages and injects it as a synthetic followup prompt.
Defaults: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## प्रति-सत्र ओवरराइड

- वर्तमान सत्र के लिए मोड संग्रहीत करने हेतु `/queue <mode>` को एक स्टैंडअलोन कमांड के रूप में भेजें।
- विकल्पों को संयोजित किया जा सकता है: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` या `/queue reset` सत्र ओवरराइड को साफ़ करता है।

## दायरा और गारंटी

- Gateway रिप्लाई पाइपलाइन का उपयोग करने वाले सभी इनबाउंड चैनलों (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, आदि) में ऑटो-रिप्लाई एजेंट रन पर लागू होता है।
- डिफ़ॉल्ट लेन (`main`) इनबाउंड + main हार्टबीट्स के लिए प्रोसेस-व्यापी है; कई सत्रों को समानांतर में अनुमति देने के लिए `agents.defaults.maxConcurrent` सेट करें।
- अतिरिक्त लेन मौजूद हो सकती हैं (उदा., `cron`, `subagent`) ताकि बैकग्राउंड जॉब्स इनबाउंड रिप्लाई को ब्लॉक किए बिना समानांतर में चल सकें।
- प्रति-सत्र लेन यह सुनिश्चित करती हैं कि किसी दिए गए सत्र को एक समय में केवल एक एजेंट रन स्पर्श करे।
- कोई बाहरी निर्भरता या बैकग्राउंड वर्कर थ्रेड नहीं; शुद्ध TypeScript + promises।

## समस्या-निवारण

- यदि कमांड अटके हुए लगें, तो verbose लॉग सक्षम करें और क्यू के ड्रेन होने की पुष्टि के लिए “queued for …ms” पंक्तियाँ देखें।
- यदि आपको क्यू गहराई की आवश्यकता हो, तो verbose लॉग सक्षम करें और क्यू टाइमिंग पंक्तियों पर नज़र रखें।
