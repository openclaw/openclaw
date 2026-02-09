---
summary: "क्रॉन और हार्टबीट शेड्यूलिंग तथा डिलीवरी से जुड़ी समस्याओं का समाधान"
read_when:
  - क्रॉन नहीं चला
  - क्रॉन चला लेकिन कोई संदेश वितरित नहीं हुआ
  - हार्टबीट शांत या छोड़ा हुआ प्रतीत होता है
title: "ऑटोमेशन समस्या-निवारण"
---

# ऑटोमेशन समस्या-निवारण

शेड्यूलर और डिलीवरी से जुड़ी समस्याओं के लिए इस पृष्ठ का उपयोग करें (`cron` + `heartbeat`).

## कमांड लैडर

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

फिर ऑटोमेशन जाँचें चलाएँ:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## क्रॉन ट्रिगर नहीं हो रहा

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

अच्छा आउटपुट ऐसा दिखता है:

- `cron status` सक्षम रिपोर्ट करता है और एक भविष्य का `nextWakeAtMs` दिखाता है।
- जॉब सक्षम है और उसके पास वैध शेड्यूल/टाइमज़ोन है।
- `cron runs` में `ok` या स्पष्ट स्किप कारण दिखता है।

सामान्य संकेत:

- `cron: scheduler disabled; jobs will not run automatically` → विन्यास/पर्यावरण में क्रॉन अक्षम है।
- `cron: timer tick failed` → शेड्यूलर टिक क्रैश हो गया; आसपास के स्टैक/लॉग संदर्भ की जाँच करें।
- रन आउटपुट में `reason: not-due` → मैनुअल रन `--force` के बिना बुलाया गया और जॉब अभी देय नहीं है।

## क्रॉन चला लेकिन डिलीवरी नहीं हुई

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

अच्छा आउटपुट ऐसा दिखता है:

- रन स्थिति `ok` है।
- आइसोलेटेड जॉब्स के लिए डिलीवरी मोड/टार्गेट सेट हैं।
- चैनल प्रोब लक्ष्य चैनल को कनेक्टेड रिपोर्ट करता है।

सामान्य संकेत:

- रन सफल हुआ लेकिन डिलीवरी मोड `none` है → किसी बाहरी संदेश की अपेक्षा नहीं है।
- डिलीवरी लक्ष्य गायब/अमान्य (`channel`/`to`) → रन आंतरिक रूप से सफल हो सकता है लेकिन आउटबाउंड स्किप हो जाता है।
- चैनल ऑथ त्रुटियाँ (`unauthorized`, `missing_scope`, `Forbidden`) → चैनल क्रेडेंशियल/अनुमतियों द्वारा डिलीवरी अवरुद्ध।

## हार्टबीट दबा हुआ या छोड़ा गया

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

अच्छा आउटपुट ऐसा दिखता है:

- हार्टबीट सक्षम है और अंतराल शून्य से अधिक है।
- अंतिम हार्टबीट परिणाम `ran` है (या स्किप कारण समझा गया है)।

सामान्य संकेत:

- `heartbeat skipped` के साथ `reason=quiet-hours` → `activeHours` के बाहर।
- `requests-in-flight` → मुख्य लेन व्यस्त; हार्टबीट स्थगित।
- `empty-heartbeat-file` → `HEARTBEAT.md` मौजूद है लेकिन कोई क्रियाशील सामग्री नहीं है।
- `alerts-disabled` → दृश्यता सेटिंग्स आउटबाउंड हार्टबीट संदेशों को दबाती हैं।

## टाइमज़ोन और activeHours की सावधानियाँ

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

त्वरित नियम:

- `Config path not found: agents.defaults.userTimezone` का अर्थ है कि कुंजी अनसेट है; हार्टबीट होस्ट टाइमज़ोन पर वापस गिरती है (या यदि सेट हो तो `activeHours.timezone`)।
- `--tz` के बिना क्रॉन Gateway होस्ट टाइमज़ोन का उपयोग करता है।
- हार्टबीट `activeHours` कॉन्फ़िगर किए गए टाइमज़ोन रेज़ोल्यूशन का उपयोग करती है (`user`, `local`, या स्पष्ट IANA tz)।
- टाइमज़ोन के बिना ISO टाइमस्टैम्प को क्रॉन `at` शेड्यूल के लिए UTC माना जाता है।

सामान्य संकेत:

- होस्ट टाइमज़ोन बदलने के बाद जॉब्स गलत वॉल-क्लॉक समय पर चलते हैं।
- हार्टबीट आपके दिन के समय में हमेशा स्किप हो जाती है क्योंकि `activeHours.timezone` गलत है।

संबंधित:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
