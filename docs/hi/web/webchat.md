---
summary: "Loopback WebChat स्थिर होस्ट और चैट UI के लिए Gateway WS उपयोग"
read_when:
  - WebChat एक्सेस को डीबग या कॉन्फ़िगर करते समय
title: "WebChat"
---

# WebChat (Gateway WebSocket UI)

स्थिति: macOS/iOS SwiftUI चैट UI सीधे Gateway WebSocket से संवाद करता है।

## यह क्या है

- Gateway के लिए एक नेटिव चैट UI (कोई एम्बेडेड ब्राउज़र नहीं और कोई स्थानीय स्थिर सर्वर नहीं)।
- अन्य चैनलों के समान सत्रों और रूटिंग नियमों का उपयोग करता है।
- निर्धारक रूटिंग: उत्तर हमेशा WebChat पर ही वापस जाते हैं।

## त्वरित प्रारंभ

1. Gateway प्रारंभ करें।
2. WebChat UI (macOS/iOS ऐप) या Control UI के चैट टैब को खोलें।
3. सुनिश्चित करें कि Gateway प्रमाणीकरण कॉन्फ़िगर है (डिफ़ॉल्ट रूप से आवश्यक, यहाँ तक कि loopback पर भी)।

## यह कैसे काम करता है (व्यवहार)

- UI Gateway WebSocket से कनेक्ट होता है और `chat.history`, `chat.send`, और `chat.inject` का उपयोग करता है।
- `chat.inject` सहायक नोट को सीधे ट्रांसक्रिप्ट में जोड़ता है और उसे UI पर ब्रॉडकास्ट करता है (कोई एजेंट रन नहीं)।
- इतिहास हमेशा Gateway से प्राप्त किया जाता है (कोई स्थानीय फ़ाइल वॉचिंग नहीं)।
- यदि Gateway अप्राप्य है, तो WebChat केवल-पढ़ने योग्य रहता है।

## दूरस्थ उपयोग

- रिमोट मोड SSH/Tailscale के माध्यम से Gateway WebSocket को टनल करता है।
- आपको अलग WebChat सर्वर चलाने की आवश्यकता नहीं है।

## विन्यास संदर्भ (WebChat)

पूर्ण विन्यास: [Configuration](/gateway/configuration)

चैनल विकल्प:

- 10. कोई समर्पित `webchat.*` ब्लॉक नहीं। 11. WebChat नीचे दिए गए गेटवे एंडपॉइंट + ऑथ सेटिंग्स का उपयोग करता है।

संबंधित वैश्विक विकल्प:

- `gateway.port`, `gateway.bind`: WebSocket होस्ट/पोर्ट।
- `gateway.auth.mode`, `gateway.auth.token`, `gateway.auth.password`: WebSocket प्रमाणीकरण।
- `gateway.remote.url`, `gateway.remote.token`, `gateway.remote.password`: रिमोट Gateway लक्ष्य।
- `session.*`: सत्र भंडारण और मुख्य कुंजी के डिफ़ॉल्ट।
