---
summary: "सीधे `openclaw agent` CLI रन (वैकल्पिक डिलीवरी के साथ)"
read_when:
  - एजेंट CLI एंट्रीपॉइंट जोड़ते या संशोधित करते समय
title: "एजेंट भेजें"
---

# `openclaw agent` (प्रत्यक्ष एजेंट रन)

`openclaw agent` runs a single agent turn without needing an inbound chat message.
By default it goes **through the Gateway**; add `--local` to force the embedded
runtime on the current machine.

## व्यवहार

- आवश्यक: `--message <text>`
- सत्र चयन:
  - `--to <dest>` सत्र कुंजी व्युत्पन्न करता है (समूह/चैनल लक्ष्य पृथक्करण बनाए रखते हैं; डायरेक्ट चैट `main` में समाहित हो जाते हैं), **या**
  - `--session-id <id>` आईडी द्वारा किसी मौजूदा सत्र का पुनः उपयोग करता है, **या**
  - `--agent <id>` किसी विन्यस्त एजेंट को सीधे लक्षित करता है (उस एजेंट की `main` सत्र कुंजी का उपयोग करता है)
- सामान्य इनबाउंड उत्तरों की तरह ही वही एम्बेडेड एजेंट रनटाइम चलाता है।
- थिंकिंग/वर्बोज़ फ़्लैग सत्र स्टोर में बने रहते हैं।
- आउटपुट:
  - डिफ़ॉल्ट: उत्तर पाठ (साथ में `MEDIA:<url>` पंक्तियाँ) प्रिंट करता है
  - `--json`: संरचित पेलोड + मेटाडेटा प्रिंट करता है
- `--deliver` + `--channel` के साथ किसी चैनल पर वैकल्पिक डिलीवरी (लक्ष्य प्रारूप `openclaw message --target` से मेल खाते हैं)।
- सत्र बदले बिना डिलीवरी ओवरराइड करने के लिए `--reply-channel`/`--reply-to`/`--reply-account` का उपयोग करें।

यदि Gateway पहुँच योग्य नहीं है, तो CLI **फ़ॉलबैक** करके एम्बेडेड लोकल रन पर चला जाता है।

## उदाहरण

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## फ़्लैग्स

- `--local`: लोकली चलाएँ (आपके शेल में मॉडल प्रदाता एपीआई कुंजियों की आवश्यकता)
- `--deliver`: चुने गए चैनल पर उत्तर भेजें
- `--channel`: डिलीवरी चैनल (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, डिफ़ॉल्ट: `whatsapp`)
- `--reply-to`: डिलीवरी लक्ष्य ओवरराइड
- `--reply-channel`: डिलीवरी चैनल ओवरराइड
- `--reply-account`: डिलीवरी अकाउंट आईडी ओवरराइड
- `--thinking <off|minimal|low|medium|high|xhigh>`: थिंकिंग स्तर स्थायी रखें (केवल GPT-5.2 + Codex मॉडल)
- `--verbose <on|full|off>`: वर्बोज़ स्तर स्थायी रखें
- `--timeout <seconds>`: एजेंट टाइमआउट ओवरराइड
- `--json`: संरचित JSON आउटपुट
