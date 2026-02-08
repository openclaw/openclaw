---
summary: "`openclaw memory` के लिए CLI संदर्भ (status/index/search)"
read_when:
  - आप सेमान्टिक मेमोरी को इंडेक्स या खोज करना चाहते हैं
  - आप मेमोरी उपलब्धता या इंडेक्सिंग का डिबग कर रहे हैं
title: "मेमोरी"
x-i18n:
  source_path: cli/memory.md
  source_hash: cb8ee2c9b2db2d57
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:02Z
---

# `openclaw memory`

सेमान्टिक मेमोरी इंडेक्सिंग और खोज का प्रबंधन करें।
सक्रिय मेमोरी प्लगइन द्वारा प्रदान किया गया (डिफ़ॉल्ट: `memory-core`; निष्क्रिय करने के लिए `plugins.slots.memory = "none"` सेट करें)।

संबंधित:

- मेमोरी अवधारणा: [Memory](/concepts/memory)
- प्लगइन्स: [Plugins](/tools/plugin)

## उदाहरण

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## विकल्प

सामान्य:

- `--agent <id>`: एकल एजेंट तक दायरा सीमित करें (डिफ़ॉल्ट: सभी विन्यस्त एजेंट)।
- `--verbose`: प्रोब और इंडेक्सिंग के दौरान विस्तृत लॉग आउटपुट करें।

नोट्स:

- `memory status --deep` वेक्टर + एम्बेडिंग उपलब्धता की जाँच करता है।
- `memory status --deep --index` यदि स्टोर डर्टी है तो पुनः इंडेक्स चलाता है।
- `memory index --verbose` प्रति-चरण विवरण प्रिंट करता है (प्रदाता, मॉडल, स्रोत, बैच गतिविधि)।
- `memory status` `memorySearch.extraPaths` के माध्यम से विन्यस्त किसी भी अतिरिक्त पाथ को शामिल करता है।
