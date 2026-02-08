---
summary: "चैनल कनेक्टिविटी के लिए स्वास्थ्य जाँच के चरण"
read_when:
  - WhatsApp चैनल स्वास्थ्य का निदान करते समय
title: "स्वास्थ्य जाँच"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:21Z
---

# स्वास्थ्य जाँच (CLI)

अनुमान लगाए बिना चैनल कनेक्टिविटी सत्यापित करने के लिए संक्षिप्त मार्गदर्शिका।

## त्वरित जाँच

- `openclaw status` — स्थानीय सारांश: Gateway (गेटवे) की पहुँच/मोड, अपडेट संकेत, लिंक किए गए चैनल का प्रमाणीकरण आयु, सत्र + हालिया गतिविधि।
- `openclaw status --all` — पूर्ण स्थानीय निदान (केवल-पठन, रंगीन, डिबगिंग के लिए पेस्ट करना सुरक्षित)।
- `openclaw status --deep` — चल रहे Gateway (गेटवे) की भी जाँच करता है (समर्थित होने पर प्रति-चैनल प्रोब)।
- `openclaw health --json` — चल रहे Gateway (गेटवे) से पूर्ण स्वास्थ्य स्नैपशॉट माँगता है (केवल WS; कोई प्रत्यक्ष Baileys सॉकेट नहीं)।
- एजेंट को बुलाए बिना स्थिति उत्तर पाने के लिए WhatsApp/WebChat में `/status` को एक स्वतंत्र संदेश के रूप में भेजें।
- लॉग्स: `/tmp/openclaw/openclaw-*.log` को टेल करें और `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound` के लिए फ़िल्टर करें।

## गहन निदान

- डिस्क पर क्रेडेंशियल्स: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime हालिया होना चाहिए)।
- सत्र स्टोर: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (पथ को विन्यास में ओवरराइड किया जा सकता है)। गणना और हालिया प्राप्तकर्ता `status` के माध्यम से प्रदर्शित होते हैं।
- रिलिंक प्रवाह: `openclaw channels logout && openclaw channels login --verbose` जब स्थिति कोड 409–515 हों या लॉग्स में `loggedOut` दिखाई दे। (टिप्पणी: पेयरिंग के बाद स्थिति 515 के लिए QR लॉगिन प्रवाह एक बार स्वतः पुनः आरंभ होता है।)

## जब कुछ विफल हो जाए

- `logged out` या स्थिति 409–515 → `openclaw channels logout` के साथ रिलिंक करें, फिर `openclaw channels login`।
- Gateway (गेटवे) अनुपलब्ध → इसे प्रारंभ करें: `openclaw gateway --port 18789` (यदि पोर्ट व्यस्त हो तो `--force` का उपयोग करें)।
- कोई इनबाउंड संदेश नहीं → पुष्टि करें कि लिंक किया गया फ़ोन ऑनलाइन है और प्रेषक अनुमत है (`channels.whatsapp.allowFrom`); समूह चैट के लिए, सुनिश्चित करें कि allowlist + मेंशन नियम मेल खाते हों (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`)।

## समर्पित "health" कमांड

`openclaw health --json` चल रहे Gateway (गेटवे) से उसका स्वास्थ्य स्नैपशॉट माँगता है (CLI से कोई प्रत्यक्ष चैनल सॉकेट नहीं)। यह उपलब्ध होने पर लिंक किए गए क्रेडेंशियल्स/प्रमाणीकरण आयु, प्रति-चैनल प्रोब सारांश, सत्र-स्टोर सारांश, और प्रोब अवधि रिपोर्ट करता है। यदि Gateway (गेटवे) अनुपलब्ध हो या प्रोब विफल/टाइमआउट हो जाए, तो यह नॉन-ज़ीरो के साथ समाप्त होता है। 10s डिफ़ॉल्ट को ओवरराइड करने के लिए `--timeout <ms>` का उपयोग करें।
