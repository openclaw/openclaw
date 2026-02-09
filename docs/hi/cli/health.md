---
summary: "`openclaw health` के लिए CLI संदर्भ (RPC के माध्यम से Gateway स्वास्थ्य एंडपॉइंट)"
read_when:
  - आप चल रहे Gateway की स्वास्थ्य स्थिति को शीघ्रता से जांचना चाहते हैं
title: "health"
---

# `openclaw health`

चल रहे Gateway से स्वास्थ्य जानकारी प्राप्त करें।

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

टिप्पणियाँ:

- `--verbose` लाइव प्रोब चलाता है और जब कई खाते विन्यस्त हों तो प्रति-खाता समय-निर्धारण प्रिंट करता है।
- आउटपुट में तब प्रति-एजेंट सत्र स्टोर्स शामिल होते हैं जब कई एजेंट विन्यस्त हों।
