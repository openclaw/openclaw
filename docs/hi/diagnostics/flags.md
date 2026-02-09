---
summary: "लक्षित डिबग लॉग्स के लिए डायग्नोस्टिक्स फ़्लैग्स"
read_when:
  - आपको वैश्विक लॉगिंग स्तर बढ़ाए बिना लक्षित डिबग लॉग्स चाहिए
  - आपको समर्थन के लिए उप-प्रणाली-विशिष्ट लॉग्स कैप्चर करने हैं
title: "डायग्नोस्टिक्स फ़्लैग्स"
---

# डायग्नोस्टिक्स फ़्लैग्स

16. Diagnostics flags आपको हर जगह verbose logging चालू किए बिना targeted debug logs सक्षम करने देते हैं। 17. Flags opt‑in होते हैं और तब तक कोई प्रभाव नहीं डालते जब तक कोई subsystem उन्हें check न करे।

## यह कैसे काम करता है

- फ़्लैग्स स्ट्रिंग्स होते हैं (केस-इंसेंसिटिव)।
- आप फ़्लैग्स को कॉन्फ़िग में या किसी env ओवरराइड के माध्यम से सक्षम कर सकते हैं।
- वाइल्डकार्ड समर्थित हैं:
  - `telegram.*` `telegram.http` से मेल खाता है
  - `*` सभी फ़्लैग्स सक्षम करता है

## कॉन्फ़िग के माध्यम से सक्षम करें

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

एक से अधिक फ़्लैग्स:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

फ़्लैग्स बदलने के बाद Gateway को पुनः प्रारंभ करें।

## Env ओवरराइड (एक-बार)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

सभी फ़्लैग्स अक्षम करें:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## लॉग्स कहाँ जाते हैं

18. Flags standard diagnostics log file में logs emit करते हैं। 19. By default:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

20. यदि आप `logging.file` सेट करते हैं, तो उसके बजाय वही path उपयोग करें। 21. Logs JSONL होते हैं (प्रति लाइन एक JSON object)। 22. `logging.redactSensitive` के आधार पर redaction अभी भी लागू होती है।

## लॉग्स निकालें

नवीनतम लॉग फ़ाइल चुनें:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP डायग्नोस्टिक्स के लिए फ़िल्टर करें:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

या पुनरुत्पादन करते समय टेल करें:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

दूरस्थ Gateways के लिए, आप `openclaw logs --follow` का भी उपयोग कर सकते हैं (देखें [/cli/logs](/cli/logs))।

## नोट्स

- 23. यदि `logging.level` को `warn` से ऊँचा सेट किया गया है, तो ये logs suppressed हो सकते हैं। 24. डिफ़ॉल्ट `info` पर्याप्त है।
- फ़्लैग्स को सक्षम छोड़ना सुरक्षित है; वे केवल विशिष्ट उप-प्रणाली के लिए लॉग वॉल्यूम को प्रभावित करते हैं।
- लॉग गंतव्यों, स्तरों और रिडैक्शन को बदलने के लिए [/logging](/logging) का उपयोग करें।
