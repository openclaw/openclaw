---
summary: "CLI संदर्भ `openclaw plugins` के लिए (सूची, इंस्टॉल, सक्षम/अक्षम, डॉक्टर)"
read_when:
  - आप इन-प्रोसेस Gateway प्लगइन्स को इंस्टॉल या प्रबंधित करना चाहते हैं
  - आप प्लगइन लोड विफलताओं का डिबग करना चाहते हैं
title: "प्लगइन्स"
x-i18n:
  source_path: cli/plugins.md
  source_hash: 60476e0a9b7247bd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:04Z
---

# `openclaw plugins`

Gateway प्लगइन्स/एक्सटेंशन्स का प्रबंधन करें (इन-प्रोसेस लोड होते हैं)।

संबंधित:

- प्लगइन सिस्टम: [Plugins](/tools/plugin)
- प्लगइन मैनिफ़ेस्ट + स्कीमा: [Plugin manifest](/plugins/manifest)
- सुरक्षा सख़्ती: [Security](/gateway/security)

## कमांड्स

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

बंडल किए गए प्लगइन्स OpenClaw के साथ आते हैं, लेकिन प्रारंभ में अक्षम रहते हैं। उन्हें सक्रिय करने के लिए `plugins enable` का उपयोग करें।

सभी प्लगइन्स के साथ एक `openclaw.plugin.json` फ़ाइल होनी चाहिए, जिसमें एक इनलाइन JSON Schema (`configSchema`, भले ही खाली हो) शामिल हो। गायब/अमान्य मैनिफ़ेस्ट या स्कीमा के कारण प्लगइन लोड नहीं होगा और विन्यास मान्यकरण विफल हो जाएगा।

### इंस्टॉल

```bash
openclaw plugins install <path-or-spec>
```

सुरक्षा टिप्पणी: प्लगइन इंस्टॉल को कोड चलाने जैसा मानें। पिन की गई संस्करणों को प्राथमिकता दें।

समर्थित आर्काइव्स: `.zip`, `.tgz`, `.tar.gz`, `.tar`।

स्थानीय डायरेक्टरी की कॉपी से बचने के लिए `--link` का उपयोग करें (यह `plugins.load.paths` में जोड़ता है):

```bash
openclaw plugins install -l ./my-plugin
```

### अपडेट

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

अपडेट केवल npm से इंस्टॉल किए गए प्लगइन्स पर लागू होते हैं (जो `plugins.installs` में ट्रैक किए जाते हैं)।
