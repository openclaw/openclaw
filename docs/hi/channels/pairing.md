---
summary: "पेयरिंग अवलोकन: कौन आपको DM कर सकता है + कौन से नोड्स शामिल हो सकते हैं"
read_when:
  - DM एक्सेस नियंत्रण सेट करते समय
  - नया iOS/Android नोड पेयर करते समय
  - OpenClaw की सुरक्षा स्थिति की समीक्षा करते समय
title: "पेयरिंग"
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:54Z
---

# पेयरिंग

“पेयरिंग” OpenClaw का स्पष्ट **मालिक-अनुमोदन** चरण है।
इसे दो स्थानों पर उपयोग किया जाता है:

1. **DM पेयरिंग** (कौन बॉट से बात करने के लिए अनुमत है)
2. **नोड पेयरिंग** (कौन से डिवाइस/नोड्स Gateway नेटवर्क में शामिल हो सकते हैं)

सुरक्षा संदर्भ: [Security](/gateway/security)

## 1) DM पेयरिंग (इनबाउंड चैट एक्सेस)

जब किसी चैनल को DM नीति `pairing` के साथ कॉन्फ़िगर किया जाता है, तो अज्ञात प्रेषकों को एक छोटा कोड मिलता है और आपकी स्वीकृति तक उनका संदेश **प्रोसेस नहीं किया जाता**।

डिफ़ॉल्ट DM नीतियाँ यहाँ प्रलेखित हैं: [Security](/gateway/security)

पेयरिंग कोड:

- 8 अक्षर, अपरकेस, बिना भ्रमित करने वाले अक्षरों के (`0O1I`)।
- **1 घंटे बाद समाप्त**। बॉट केवल तब पेयरिंग संदेश भेजता है जब नया अनुरोध बनाया जाता है (लगभग प्रति प्रेषक प्रति घंटे एक बार)।
- लंबित DM पेयरिंग अनुरोध डिफ़ॉल्ट रूप से **प्रति चैनल 3** तक सीमित हैं; जब तक कोई अनुरोध समाप्त या स्वीकृत न हो जाए, अतिरिक्त अनुरोध अनदेखे किए जाते हैं।

### किसी प्रेषक को स्वीकृत करें

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

समर्थित चैनल: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`।

### स्थिति कहाँ संग्रहीत रहती है

`~/.openclaw/credentials/` के अंतर्गत संग्रहीत:

- लंबित अनुरोध: `<channel>-pairing.json`
- स्वीकृत allowlist स्टोर: `<channel>-allowFrom.json`

इन्हें संवेदनशील मानें (ये आपके सहायक तक पहुँच को नियंत्रित करते हैं)।

## 2) नोड डिवाइस पेयरिंग (iOS/Android/macOS/हेडलैस नोड्स)

नोड्स Gateway से **डिवाइस** के रूप में `role: node` के साथ कनेक्ट होते हैं। Gateway
एक डिवाइस पेयरिंग अनुरोध बनाता है जिसे स्वीकृत करना आवश्यक है।

### किसी नोड डिवाइस को स्वीकृत करें

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### नोड पेयरिंग स्थिति भंडारण

`~/.openclaw/devices/` के अंतर्गत संग्रहीत:

- `pending.json` (अल्पकालिक; लंबित अनुरोध समाप्त हो जाते हैं)
- `paired.json` (पेयर किए गए डिवाइस + टोकन)

### नोट्स

- लेगेसी `node.pair.*` API (CLI: `openclaw nodes pending/approve`) एक
  अलग Gateway-स्वामित्व वाला पेयरिंग स्टोर है। WS नोड्स को अभी भी डिवाइस पेयरिंग की आवश्यकता होती है।

## संबंधित दस्तावेज़

- सुरक्षा मॉडल + प्रॉम्प्ट इंजेक्शन: [Security](/gateway/security)
- सुरक्षित रूप से अपडेट करना (डॉक्टर चलाएँ): [Updating](/install/updating)
- चैनल विन्यास:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (लेगेसी): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
