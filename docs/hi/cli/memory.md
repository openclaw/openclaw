---
summary: "`openclaw memory` के लिए CLI संदर्भ (status/index/search)"
read_when:
  - आप सेमान्टिक मेमोरी को इंडेक्स या खोज करना चाहते हैं
  - आप मेमोरी उपलब्धता या इंडेक्सिंग का डिबग कर रहे हैं
title: "मेमोरी"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

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
