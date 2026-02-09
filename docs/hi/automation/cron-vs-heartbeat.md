---
summary: "स्वचालन के लिए heartbeat और cron जॉब्स के बीच चयन करने हेतु मार्गदर्शन"
read_when:
  - आवर्ती कार्यों को कैसे शेड्यूल करें, यह तय करते समय
  - पृष्ठभूमि मॉनिटरिंग या सूचनाएँ सेट करते समय
  - आवधिक जाँच के लिए टोकन उपयोग का अनुकूलन करते समय
title: "Cron बनाम Heartbeat"
---

# Cron बनाम Heartbeat: प्रत्येक का उपयोग कब करें

Heartbeats और cron jobs दोनों आपको schedule पर tasks चलाने देते हैं। यह guide आपके use case के लिए सही mechanism चुनने में मदद करता है।

## त्वरित निर्णय मार्गदर्शिका

| उपयोग‑मामला                        | अनुशंसित                               | कारण                                        |
| ---------------------------------- | -------------------------------------- | ------------------------------------------- |
| हर 30 मिनट में इनबॉक्स जाँचें      | Heartbeat                              | अन्य जाँचों के साथ बैच होता है, संदर्भ‑सचेत |
| रोज़ ठीक 9 बजे रिपोर्ट भेजें       | Cron (isolated)     | सटीक समय आवश्यक                             |
| आगामी घटनाओं के लिए कैलेंडर मॉनिटर | Heartbeat                              | आवधिक जागरूकता के लिए स्वाभाविक विकल्प      |
| साप्ताहिक गहन विश्लेषण चलाएँ       | Cron (isolated)     | स्वतंत्र कार्य, अलग मॉडल उपयोग कर सकता है   |
| 20 मिनट में याद दिलाएँ             | Cron (main, `--at`) | एक‑बार का, सटीक समय के साथ                  |
| पृष्ठभूमि परियोजना स्वास्थ्य जाँच  | Heartbeat                              | मौजूदा चक्र पर निर्भर                       |

## Heartbeat: आवधिक जागरूकता

Heartbeats **main session** में एक नियमित interval पर चलते हैं (डिफ़ॉल्ट: 30 min)। इन्हें agent के लिए चीज़ों की जाँच करने और जो भी महत्वपूर्ण हो उसे surface करने के लिए डिज़ाइन किया गया है।

### Heartbeat का उपयोग कब करें

- **कई आवधिक जाँचें**: इनबॉक्स, कैलेंडर, मौसम, सूचनाएँ और परियोजना स्थिति जाँचने के लिए 5 अलग‑अलग cron जॉब्स के बजाय, एक ही heartbeat इन सभी को बैच कर सकता है।
- **संदर्भ‑सचेत निर्णय**: एजेंट के पास पूर्ण मुख्य‑सत्र संदर्भ होता है, इसलिए वह तय कर सकता है कि क्या तत्काल है और क्या प्रतीक्षा कर सकता है।
- **संवादात्मक निरंतरता**: Heartbeat रन एक ही सत्र साझा करते हैं, इसलिए एजेंट हाल की बातचीत याद रखता है और स्वाभाविक रूप से फ़ॉलो‑अप कर सकता है।
- **कम ओवरहेड मॉनिटरिंग**: एक heartbeat कई छोटे polling कार्यों को प्रतिस्थापित करता है।

### Heartbeat के लाभ

- **कई जाँचों का बैच**: एक एजेंट टर्न में इनबॉक्स, कैलेंडर और सूचनाओं की साथ‑साथ समीक्षा।
- **API कॉल्स में कमी**: एक heartbeat, 5 अलग‑थलग cron जॉब्स से सस्ता पड़ता है।
- **संदर्भ‑सचेत**: एजेंट जानता है कि आप किस पर काम कर रहे हैं और उसी अनुसार प्राथमिकता देता है।
- **स्मार्ट सप्रेशन**: यदि ध्यान देने योग्य कुछ नहीं है, तो एजेंट `HEARTBEAT_OK` का उत्तर देता है और कोई संदेश वितरित नहीं होता।
- **स्वाभाविक टाइमिंग**: क्यू लोड के आधार पर हल्का‑सा ड्रिफ्ट होता है, जो अधिकांश मॉनिटरिंग के लिए ठीक है।

### Heartbeat उदाहरण: HEARTBEAT.md चेकलिस्ट

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

एजेंट प्रत्येक heartbeat पर इसे पढ़ता है और सभी आइटम एक ही टर्न में संभालता है।

### Heartbeat कॉन्फ़िगर करना

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

पूर्ण विन्यास के लिए [Heartbeat](/gateway/heartbeat) देखें।

## Cron: सटीक शेड्यूलिंग

Cron जॉब्स **सटीक समयों** पर चलते हैं और मुख्य संदर्भ को प्रभावित किए बिना isolated सत्रों में चल सकते हैं।

### Cron का उपयोग कब करें

- **सटीक समय आवश्यक**: “हर सोमवार सुबह 9:00 बजे भेजें” (ना कि “9 के आसपास कभी”).
- **स्वतंत्र कार्य**: जिन्हें संवादात्मक संदर्भ की आवश्यकता नहीं।
- **अलग मॉडल/सोच**: भारी विश्लेषण जिनके लिए अधिक शक्तिशाली मॉडल उचित हो।
- **एक‑बार की रिमाइंडर**: “20 मिनट में याद दिलाओ” — `--at` के साथ।
- **शोरदार/बार‑बार के कार्य**: जो मुख्य सत्र इतिहास को अव्यवस्थित कर दें।
- **बाहरी ट्रिगर**: जो एजेंट की अन्य गतिविधियों से स्वतंत्र रूप से चलने चाहिए।

### Cron के लाभ

- **सटीक टाइमिंग**: टाइमज़ोन समर्थन के साथ 5‑फ़ील्ड cron अभिव्यक्तियाँ।
- **सत्र पृथक्करण**: `cron:<jobId>` में चलता है, जिससे मुख्य इतिहास प्रदूषित नहीं होता।
- **मॉडल ओवरराइड्स**: प्रति जॉब सस्ता या अधिक शक्तिशाली मॉडल उपयोग करें।
- **डिलीवरी नियंत्रण**: isolated जॉब्स डिफ़ॉल्ट रूप से `announce` (सारांश); आवश्यकता अनुसार `none` चुनें।
- **तत्काल डिलीवरी**: Announce मोड heartbeat की प्रतीक्षा किए बिना सीधे पोस्ट करता है।
- **एजेंट संदर्भ की आवश्यकता नहीं**: मुख्य सत्र निष्क्रिय या संकुचित होने पर भी चलता है।
- **एक‑बार समर्थन**: सटीक भविष्य टाइमस्टैम्प के लिए `--at`।

### Cron उदाहरण: दैनिक सुबह की ब्रीफ़िंग

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

यह न्यूयॉर्क समयानुसार ठीक सुबह 7:00 बजे चलता है, गुणवत्ता के लिए Opus का उपयोग करता है, और WhatsApp पर सीधे सारांश घोषित करता है।

### Cron उदाहरण: एक‑बार की रिमाइंडर

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

पूर्ण CLI संदर्भ के लिए [Cron jobs](/automation/cron-jobs) देखें।

## निर्णय फ़्लोचार्ट

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## दोनों को मिलाकर उपयोग

सबसे कुशल सेटअप **दोनों** का उपयोग करता है:

1. **Heartbeat** हर 30 मिनट में एक बैच्ड टर्न में नियमित मॉनिटरिंग (इनबॉक्स, कैलेंडर, सूचनाएँ) संभालता है।
2. **Cron** सटीक शेड्यूल (दैनिक रिपोर्ट, साप्ताहिक समीक्षा) और एक‑बार की रिमाइंडर संभालता है।

### उदाहरण: कुशल स्वचालन सेटअप

**HEARTBEAT.md** (हर 30 मिनट में जाँचा जाता है):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (सटीक टाइमिंग):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: अनुमोदनों के साथ निर्धारक वर्कफ़्लो

Lobster **multi-step tool pipelines** के लिए workflow runtime है जिन्हें deterministic execution और explicit approvals की आवश्यकता होती है।
जब task एक single agent turn से अधिक हो, और आपको human checkpoints के साथ resumable workflow चाहिए, तब इसका उपयोग करें।

### Lobster कब उपयुक्त है

- **बहु‑चरण स्वचालन**: आपको एक स्थिर टूल‑कॉल पाइपलाइन चाहिए, न कि एक‑बार का प्रॉम्प्ट।
- **अनुमोदन गेट्स**: साइड‑इफ़ेक्ट्स को आपके अनुमोदन तक रोकना, फिर पुनः शुरू करना।
- **पुनःआरंभ योग्य रन**: पहले के चरणों को दोबारा चलाए बिना रुके हुए वर्कफ़्लो को जारी रखना।

### Heartbeat और Cron के साथ इसका संयोजन

- **Heartbeat/cron** तय करते हैं कि रन _कब_ होगा।
- **Lobster** तय करता है कि रन शुरू होने पर _कौन‑से चरण_ होंगे।

Scheduled workflows के लिए, एक agent turn trigger करने हेतु cron या heartbeat का उपयोग करें जो Lobster को कॉल करे।
Ad-hoc workflows के लिए, Lobster को सीधे कॉल करें।

### परिचालन नोट्स (कोड से)

- Lobster टूल मोड में **local subprocess** (`lobster` CLI) के रूप में चलता है और एक **JSON envelope** लौटाता है।
- यदि टूल `needs_approval` लौटाता है, तो आप `resumeToken` और `approve` फ़्लैग के साथ पुनः शुरू करते हैं।
- यह टूल एक **वैकल्पिक प्लगइन** है; `tools.alsoAllow: ["lobster"]` के माध्यम से इसे ऐडिटिव रूप से सक्षम करें (अनुशंसित)।
- यदि आप `lobsterPath` पास करते हैं, तो वह एक **absolute path** होना चाहिए।

पूर्ण उपयोग और उदाहरणों के लिए [Lobster](/tools/lobster) देखें।

## मुख्य सत्र बनाम Isolated सत्र

Heartbeat और cron—दोनों—मुख्य सत्र के साथ इंटरैक्ट कर सकते हैं, लेकिन अलग‑अलग तरीकों से:

|         | Heartbeat                          | Cron (main)                      | Cron (isolated)            |
| ------- | ---------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| Session | Main                               | Main (system event के माध्यम से) | `cron:<jobId>`                                |
| History | Shared                             | Shared                                              | प्रत्येक रन में नया                           |
| Context | Full                               | Full                                                | None (साफ़ शुरुआत)         |
| Model   | Main session model                 | Main session model                                  | ओवरराइड कर सकता है                            |
| Output  | यदि `HEARTBEAT_OK` नहीं, तो वितरित | Heartbeat प्रॉम्प्ट + इवेंट                         | Announce सारांश (डिफ़ॉल्ट) |

### मुख्य सत्र cron कब उपयोग करें

जब आप निम्न चाहते हों, तब `--session main` को `--system-event` के साथ उपयोग करें:

- रिमाइंडर/इवेंट मुख्य सत्र संदर्भ में दिखाई दे
- एजेंट अगले heartbeat के दौरान पूर्ण संदर्भ के साथ इसे संभाले
- कोई अलग isolated रन न हो

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Isolated cron कब उपयोग करें

जब आप निम्न चाहते हों, तब `--session isolated` का उपयोग करें:

- पूर्व संदर्भ के बिना साफ़ शुरुआत
- अलग मॉडल या सोच सेटिंग्स
- किसी चैनल पर सीधे सारांश घोषित करना
- ऐसा इतिहास जो मुख्य सत्र को अव्यवस्थित न करे

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## लागत संबंधी विचार

| तंत्र                              | लागत प्रोफ़ाइल                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Heartbeat                          | हर N मिनट में एक टर्न; HEARTBEAT.md के आकार के साथ स्केल       |
| Cron (main)     | अगले heartbeat में इवेंट जोड़ता है (कोई isolated टर्न नहीं) |
| Cron (isolated) | प्रति जॉब पूर्ण एजेंट टर्न; सस्ता मॉडल उपयोग कर सकता है                        |

**सुझाव**:

- टोकन ओवरहेड कम करने के लिए `HEARTBEAT.md` को छोटा रखें।
- कई cron जॉब्स के बजाय समान जाँचों को heartbeat में बैच करें।
- यदि केवल आंतरिक प्रोसेसिंग चाहिए, तो heartbeat पर `target: "none"` का उपयोग करें।
- नियमित कार्यों के लिए सस्ते मॉडल के साथ isolated cron का उपयोग करें।

## संबंधित

- [Heartbeat](/gateway/heartbeat) - पूर्ण heartbeat विन्यास
- [Cron jobs](/automation/cron-jobs) - पूर्ण cron CLI और API संदर्भ
- [System](/cli/system) - system events + heartbeat नियंत्रण
