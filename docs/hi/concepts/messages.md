---
summary: "संदेश प्रवाह, सत्र, कतारबद्धता, और तर्क दृश्यता"
read_when:
  - यह समझाने के लिए कि इनबाउंड संदेश कैसे उत्तर बनते हैं
  - सत्रों, कतारबद्धता मोड, या स्ट्रीमिंग व्यवहार को स्पष्ट करने के लिए
  - तर्क दृश्यता और उपयोग संबंधी प्रभावों का दस्तावेज़ीकरण करने के लिए
title: "संदेश"
---

# संदेश

यह पृष्ठ बताता है कि OpenClaw इनबाउंड संदेशों, सत्रों, कतारबद्धता,
स्ट्रीमिंग, और तर्क दृश्यता को कैसे संभालता है।

## संदेश प्रवाह (उच्च स्तर)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

मुख्य नियंत्रण विन्यास में रहते हैं:

- उपसर्गों, कतारबद्धता, और समूह व्यवहार के लिए `messages.*`।
- ब्लॉक स्ट्रीमिंग और चंकिंग डिफ़ॉल्ट के लिए `agents.defaults.*`।
- 20. चैनल ओवरराइड्स (`channels.whatsapp.*`, `channels.telegram.*`, आदि) 21. कैप्स और स्ट्रीमिंग टॉगल्स के लिए।

पूर्ण स्कीमा के लिए [Configuration](/gateway/configuration) देखें।

## इनबाउंड डीडुप्लीकेशन

22. चैनल्स री‑कनेक्ट के बाद वही संदेश दोबारा डिलीवर कर सकते हैं। 23. OpenClaw चैनल/अकाउंट/पीयर/सत्र/मैसेज id से keyed एक
    short‑lived कैश रखता है ताकि डुप्लिकेट
    डिलीवरी एक और एजेंट रन को ट्रिगर न करें।

## इनबाउंड डिबाउंसिंग

24. **एक ही प्रेषक** से आए तेज़ लगातार संदेशों को `messages.inbound` के ज़रिए एक ही
    एजेंट टर्न में बैच किया जा सकता है। 25. डिबाउंसिंग प्रति चैनल + बातचीत के दायरे में होती है
    और उत्तर थ्रेडिंग/IDs के लिए सबसे हालिया संदेश का उपयोग करती है।

विन्यास (वैश्विक डिफ़ॉल्ट + प्रति-चैनल ओवरराइड्स):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

नोट्स:

- डिबाउंस केवल **केवल-पाठ** संदेशों पर लागू होता है; मीडिया/अटैचमेंट तुरंत फ्लश होते हैं।
- नियंत्रण कमांड डिबाउंसिंग को बायपास करते हैं ताकि वे स्वतंत्र रहें।

## सत्र और डिवाइस

सत्र Gateway के स्वामित्व में होते हैं, क्लाइंट्स के नहीं।

- डायरेक्ट चैट्स एजेंट के मुख्य सत्र कुंजी में समाहित हो जाती हैं।
- समूह/चैनल अपने स्वयं के सत्र कुंजी प्राप्त करते हैं।
- सत्र स्टोर और ट्रांसक्रिप्ट Gateway होस्ट पर रहते हैं।

26. कई डिवाइस/चैनल एक ही सत्र से मैप हो सकते हैं, लेकिन इतिहास पूरी तरह
    हर क्लाइंट में वापस सिंक नहीं होता। 27. सिफ़ारिश: संदर्भ के विचलन से बचने के लिए लंबी
    बातचीत के लिए एक प्राथमिक डिवाइस का उपयोग करें। 28. Control UI और TUI हमेशा
    gateway‑backed सत्र ट्रांसक्रिप्ट दिखाते हैं, इसलिए वही source of truth हैं।

विवरण: [Session management](/concepts/session)।

## इनबाउंड बॉडीज़ और इतिहास संदर्भ

OpenClaw **प्रॉम्प्ट बॉडी** को **कमांड बॉडी** से अलग करता है:

- 29. `Body`: एजेंट को भेजा गया प्रॉम्प्ट टेक्स्ट। 30. इसमें चैनल एनवलप्स और
      वैकल्पिक history wrappers शामिल हो सकते हैं।
- `CommandBody`: निर्देश/कमांड पार्सिंग के लिए कच्चा उपयोगकर्ता पाठ।
- `RawBody`: `CommandBody` के लिए लीगेसी उपनाम (संगतता के लिए रखा गया)।

जब कोई चैनल इतिहास प्रदान करता है, तो वह एक साझा रैपर का उपयोग करता है:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

31. **non‑direct chats** (groups/channels/rooms) के लिए, **current message body** को
    sender लेबल के साथ प्रीफ़िक्स किया जाता है (इतिहास प्रविष्टियों में उपयोग की जाने वाली वही शैली)। 32. इससे रियल‑टाइम और queued/history
    संदेश एजेंट प्रॉम्प्ट में सुसंगत रहते हैं।

इतिहास बफ़र **केवल-पेंडिंग** होते हैं: इनमें वे समूह संदेश शामिल होते हैं जिन्होंने
रन ट्रिगर नहीं किया (उदाहरण के लिए, मेंशन-गेटेड संदेश) और **उन संदेशों को बाहर**
रखते हैं जो पहले से सत्र ट्रांसक्रिप्ट में हैं।

33. Directive stripping केवल **current message** सेक्शन पर लागू होती है ताकि इतिहास
    अक्षुण्ण रहे। 34. जो चैनल इतिहास को रैप करते हैं, उन्हें `CommandBody` (या
    `RawBody`) को मूल संदेश टेक्स्ट पर सेट करना चाहिए और `Body` को संयुक्त प्रॉम्प्ट के रूप में रखना चाहिए।
34. History buffers `messages.groupChat.historyLimit` (global
    default) और per‑channel ओवरराइड्स जैसे `channels.slack.historyLimit` या
    `channels.telegram.accounts.<id>36. .historyLimit` (डिसेबल करने के लिए `0` सेट करें)।

## कतारबद्धता और फॉलोअप्स

यदि कोई रन पहले से सक्रिय है, तो इनबाउंड संदेशों को कतार में रखा जा सकता है,
वर्तमान रन में निर्देशित किया जा सकता है, या फॉलोअप टर्न के लिए एकत्र किया जा सकता है।

- `messages.queue` (और `messages.queue.byChannel`) के माध्यम से विन्यास करें।
- मोड्स: `interrupt`, `steer`, `followup`, `collect`, साथ ही बैकलॉग वेरिएंट्स।

विवरण: [Queueing](/concepts/queue)।

## स्ट्रीमिंग, चंकिंग, और बैचिंग

37. Block streaming मॉडल द्वारा टेक्स्ट ब्लॉक्स बनते ही आंशिक उत्तर भेजता है।
38. Chunking चैनल टेक्स्ट सीमाओं का सम्मान करता है और fenced code को विभाजित करने से बचता है।

मुख्य सेटिंग्स:

- `agents.defaults.blockStreamingDefault` (`on|off`, डिफ़ॉल्ट बंद)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (आइडल-आधारित बैचिंग)
- `agents.defaults.humanDelay` (ब्लॉक उत्तरों के बीच मानव-सदृश विराम)
- चैनल ओवरराइड्स: `*.blockStreaming` और `*.blockStreamingCoalesce` (गैर-Telegram चैनलों के लिए स्पष्ट `*.blockStreaming: true` आवश्यक)

विवरण: [Streaming + chunking](/concepts/streaming)।

## तर्क दृश्यता और टोकन

OpenClaw मॉडल तर्क को प्रदर्शित या छिपा सकता है:

- `/reasoning on|off|stream` दृश्यता को नियंत्रित करता है।
- मॉडल द्वारा उत्पन्न होने पर तर्क सामग्री अभी भी टोकन उपयोग में गिनी जाती है।
- Telegram ड्राफ्ट बबल में तर्क स्ट्रीम का समर्थन करता है।

विवरण: [Thinking + reasoning directives](/tools/thinking) और [Token use](/reference/token-use)।

## उपसर्ग, थ्रेडिंग, और उत्तर

आउटबाउंड संदेश स्वरूपण `messages` में केंद्रीकृत है:

- 39. `messages.responsePrefix`, `channels.<channel>40. .responsePrefix`, और `channels.<channel>41. .accounts.<id>42. .responsePrefix` (outbound prefix cascade), साथ ही `channels.whatsapp.messagePrefix` (WhatsApp inbound prefix)
- `replyToMode` और प्रति-चैनल डिफ़ॉल्ट्स के माध्यम से उत्तर थ्रेडिंग

विवरण: [Configuration](/gateway/configuration#messages) और चैनल दस्तावेज़।
