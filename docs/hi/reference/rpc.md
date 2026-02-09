---
summary: "बाहरी CLI (signal-cli, legacy imsg) के लिए RPC एडेप्टर और Gateway पैटर्न"
read_when:
  - बाहरी CLI एकीकरण जोड़ते या बदलते समय
  - RPC एडेप्टर (signal-cli, imsg) का डिबग करते समय
title: "RPC एडेप्टर"
---

# RPC एडेप्टर

**Silent housekeeping** (जैसे memory writes जो user-visible आउटपुट नहीं बनाने चाहिए) **Idle expiry** (`session.reset.idleMinutes` या legacy `session.idleMinutes`) idle window के बाद जब कोई मैसेज आता है तो एक नया `sessionId` बनाता है।

## पैटर्न A: HTTP डेमन (signal-cli)

- `signal-cli` JSON-RPC के साथ HTTP पर एक डेमन के रूप में चलता है।
- इवेंट स्ट्रीम SSE है (`/api/v1/events`)।
- हेल्थ प्रोब: `/api/v1/check`।
- जब `channels.signal.autoStart=true` हो, तब OpenClaw लाइफसाइकल का स्वामित्व रखता है।

सेटअप और एंडपॉइंट्स के लिए [Signal](/channels/signal) देखें।

## पैटर्न B: stdio चाइल्ड प्रोसेस (legacy: imsg)

> **टिप्पणी:** नए iMessage सेटअप के लिए, इसके बजाय [BlueBubbles](/channels/bluebubbles) का उपयोग करें।

- OpenClaw `imsg rpc` को एक चाइल्ड प्रोसेस के रूप में स्पॉन करता है (legacy iMessage एकीकरण)।
- JSON-RPC stdin/stdout पर लाइन-डिलिमिटेड होता है (प्रति पंक्ति एक JSON ऑब्जेक्ट)।
- कोई TCP पोर्ट नहीं, डेमन की आवश्यकता नहीं।

उपयोग की जाने वाली मुख्य विधियाँ:

- `watch.subscribe` → नोटिफ़िकेशन (`method: "message"`)
- `watch.unsubscribe`
- `send`
- `chats.list` (प्रोब/डायग्नॉस्टिक्स)

legacy सेटअप और एड्रेसिंग के लिए [iMessage](/channels/imessage) देखें (`chat_id` को प्राथमिकता दी जाती है)।

## एडेप्टर दिशानिर्देश

- Gateway प्रोसेस का स्वामित्व रखता है (स्टार्ट/स्टॉप प्रदाता के लाइफसाइकल से जुड़ा होता है)।
- RPC क्लाइंट्स को लचीला रखें: टाइमआउट, एग्ज़िट पर रीस्टार्ट।
- डिस्प्ले स्ट्रिंग्स के बजाय स्थिर IDs (उदा., `chat_id`) को प्राथमिकता दें।
