---
summary: "`openclaw cron` के लिए CLI संदर्भ (अनुसूचित करें और पृष्ठभूमि जॉब्स चलाएँ)"
read_when:
  - आपको अनुसूचित जॉब्स और वेकअप्स चाहिए
  - आप cron निष्पादन और लॉग्स का डिबग कर रहे हैं
title: "cron"
x-i18n:
  source_path: cli/cron.md
  source_hash: 09982d6dd1036a56
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:00Z
---

# `openclaw cron`

Gateway शेड्यूलर के लिए cron जॉब्स प्रबंधित करें।

संबंधित:

- क्रॉन जॉब्स: [Cron jobs](/automation/cron-jobs)

सुझाव: पूर्ण कमांड सतह के लिए `openclaw cron --help` चलाएँ।

टिप्पणी: पृथक `cron add` जॉब्स डिफ़ॉल्ट रूप से `--announce` डिलीवरी पर सेट होते हैं। आउटपुट को
आंतरिक रखने के लिए `--no-deliver` का उपयोग करें। `--deliver` `--announce` के लिए एक अप्रचलित उपनाम के रूप में बना रहता है।

टिप्पणी: वन-शॉट (`--at`) जॉब्स सफलता के बाद डिफ़ॉल्ट रूप से हटा दिए जाते हैं। उन्हें बनाए रखने के लिए `--keep-after-run` का उपयोग करें।

टिप्पणी: आवर्ती जॉब्स अब लगातार त्रुटियों के बाद घातीय पुनःप्रयास बैकऑफ का उपयोग करते हैं (30s → 1m → 5m → 15m → 60m), फिर अगली सफल रन के बाद सामान्य शेड्यूल पर लौट आते हैं।

## सामान्य संपादन

संदेश बदले बिना डिलीवरी सेटिंग्स अपडेट करें:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

पृथक जॉब के लिए डिलीवरी अक्षम करें:

```bash
openclaw cron edit <job-id> --no-deliver
```

किसी विशिष्ट चैनल में घोषणा करें:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
