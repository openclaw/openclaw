---
summary: "Skills विन्यास स्कीमा और उदाहरण"
read_when:
  - Skills विन्यास जोड़ते या संशोधित करते समय
  - बंडल्ड allowlist या इंस्टॉल व्यवहार समायोजित करते समय
title: "Skills Config"
---

# Skills Config

Skills से संबंधित सभी विन्यास `skills` के अंतर्गत `~/.openclaw/openclaw.json` में रहते हैं।

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Fields

- `allowBundled`: केवल **बंडल्ड** स्किल्स के लिए वैकल्पिक allowlist। जब सेट किया जाता है, तो सूची में मौजूद केवल
  बंडल्ड स्किल्स ही पात्र होती हैं (managed/workspace स्किल्स अप्रभावित रहती हैं)।
- `load.extraDirs`: स्कैन करने के लिए अतिरिक्त skill निर्देशिकाएँ (सबसे कम प्राथमिकता)।
- `load.watch`: skill फ़ोल्डरों पर नज़र रखें और skills स्नैपशॉट को रिफ्रेश करें (डिफ़ॉल्ट: true)।
- `load.watchDebounceMs`: skill watcher घटनाओं के लिए डिबाउंस समय, मिलीसेकंड में (डिफ़ॉल्ट: 250)।
- `install.preferBrew`: उपलब्ध होने पर brew installers को प्राथमिकता दें (डिफ़ॉल्ट: true)।
- `install.nodeManager`: नोड इंस्टॉलर प्राथमिकता (`npm` | `pnpm` | `yarn` | `bun`, डिफ़ॉल्ट: npm)।
  यह केवल **स्किल इंस्टॉल** को प्रभावित करता है; गेटवे रनटाइम अभी भी Node होना चाहिए
  (WhatsApp/Telegram के लिए Bun अनुशंसित नहीं है)।
- \`entries.<skillKey>\`\`: प्रति-स्किल ओवरराइड्स।

प्रति-skill फ़ील्ड्स:

- `enabled`: किसी skill को अक्षम करने के लिए `false` सेट करें, भले ही वह bundled/installed हो।
- `env`: एजेंट रन के लिए इंजेक्ट किए गए environment variables (केवल तब, जब पहले से सेट न हों)।
- `apiKey`: उन skills के लिए वैकल्पिक सुविधा जो एक प्राथमिक env var घोषित करते हैं।

## Notes

- `entries` के अंतर्गत कीज़ डिफ़ॉल्ट रूप से स्किल नाम से मैप होती हैं। यदि कोई स्किल
  `metadata.openclaw.skillKey` परिभाषित करता है, तो उसी की का उपयोग किया जाता है।
- watcher सक्षम होने पर skills में किए गए परिवर्तन अगले एजेंट टर्न पर लागू हो जाते हैं।

### Sandboxed skills + env vars

जब कोई सेशन **sandboxed** होता है, तो स्किल प्रोसेसेस Docker के अंदर चलते हैं। सैंडबॉक्स
होस्ट `process.env` को **विरासत में नहीं लेता**।

इनमें से किसी एक का उपयोग करें:

- `agents.defaults.sandbox.docker.env` (या प्रति-एजेंट `agents.list[].sandbox.docker.env`)
- अपने कस्टम sandbox इमेज में env को bake करें

ग्लोबल `env` और `skills.entries.<skill>`.env/apiKey\` केवल **होस्ट** रन पर लागू होते हैं।
