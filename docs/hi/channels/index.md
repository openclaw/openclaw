---
summary: "वे मैसेजिंग प्लेटफ़ॉर्म जिनसे OpenClaw जुड़ सकता है"
read_when:
  - आप OpenClaw के लिए एक चैट चैनल चुनना चाहते हैं
  - आपको समर्थित मैसेजिंग प्लेटफ़ॉर्म का त्वरित अवलोकन चाहिए
title: "चैट चैनल"
---

# चैट चैनल

42. OpenClaw किसी भी chat app पर आपसे बात कर सकता है जिसे आप पहले से उपयोग करते हैं। 43. प्रत्येक चैनल Gateway के माध्यम से कनेक्ट होता है।
43. टेक्स्ट हर जगह समर्थित है; मीडिया और reactions चैनल के अनुसार भिन्न होते हैं।

## समर्थित चैनल

- [WhatsApp](/channels/whatsapp) — सबसे लोकप्रिय; Baileys का उपयोग करता है और QR पेयरिंग की आवश्यकता होती है।
- [Telegram](/channels/telegram) — grammY के माध्यम से Bot API; समूहों का समर्थन करता है।
- [Discord](/channels/discord) — Discord Bot API + Gateway; सर्वर, चैनल और DMs का समर्थन करता है।
- [Slack](/channels/slack) — Bolt SDK; वर्कस्पेस ऐप्स।
- [Feishu](/channels/feishu) — WebSocket के माध्यम से Feishu/Lark बॉट (प्लगइन, अलग से इंस्टॉल)।
- [Google Chat](/channels/googlechat) — HTTP webhook के माध्यम से Google Chat API ऐप।
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; चैनल, समूह, DMs (प्लगइन, अलग से इंस्टॉल)।
- [Signal](/channels/signal) — signal-cli; गोपनीयता-केंद्रित।
- [BlueBubbles](/channels/bluebubbles) — **iMessage के लिए अनुशंसित**; पूर्ण फीचर समर्थन के साथ BlueBubbles macOS सर्वर REST API का उपयोग करता है (संपादन, अनसेंड, इफ़ेक्ट्स, रिएक्शंस, समूह प्रबंधन — macOS 26 Tahoe पर संपादन वर्तमान में टूटा हुआ है)।
- [iMessage (legacy)](/channels/imessage) — imsg CLI के माध्यम से लेगेसी macOS एकीकरण (deprecated, नए सेटअप के लिए BlueBubbles का उपयोग करें)।
- [Microsoft Teams](/channels/msteams) — Bot Framework; एंटरप्राइज़ समर्थन (प्लगइन, अलग से इंस्टॉल)।
- [LINE](/channels/line) — LINE Messaging API बॉट (प्लगइन, अलग से इंस्टॉल)।
- [Nextcloud Talk](/channels/nextcloud-talk) — Nextcloud Talk के माध्यम से स्व-होस्टेड चैट (प्लगइन, अलग से इंस्टॉल)।
- [Matrix](/channels/matrix) — Matrix प्रोटोकॉल (प्लगइन, अलग से इंस्टॉल)।
- [Nostr](/channels/nostr) — NIP-04 के माध्यम से विकेंद्रीकृत DMs (प्लगइन, अलग से इंस्टॉल)।
- [Tlon](/channels/tlon) — Urbit-आधारित मैसेंजर (प्लगइन, अलग से इंस्टॉल)।
- [Twitch](/channels/twitch) — IRC कनेक्शन के माध्यम से Twitch चैट (प्लगइन, अलग से इंस्टॉल)।
- [Zalo](/channels/zalo) — Zalo Bot API; वियतनाम का लोकप्रिय मैसेंजर (प्लगइन, अलग से इंस्टॉल)।
- [Zalo Personal](/channels/zalouser) — QR लॉगिन के माध्यम से Zalo व्यक्तिगत खाता (प्लगइन, अलग से इंस्टॉल)।
- [WebChat](/web/webchat) — WebSocket के ऊपर Gateway WebChat UI।

## टिप्पणियाँ

- चैनल एक साथ चल सकते हैं; कई कॉन्फ़िगर करें और OpenClaw प्रति चैट रूट करेगा।
- 45. सबसे तेज़ सेटअप आमतौर पर **Telegram** होता है (सरल bot token)। 46. WhatsApp को QR pairing की आवश्यकता होती है और
      डिस्क पर अधिक state स्टोर करता है।
- समूह व्यवहार चैनल के अनुसार भिन्न होता है; देखें [Groups](/channels/groups)।
- सुरक्षा के लिए DM पेयरिंग और allowlists लागू की जाती हैं; देखें [Security](/gateway/security)।
- Telegram आंतरिक विवरण: [grammY notes](/channels/grammy)।
- समस्या-निवारण: [Channel troubleshooting](/channels/troubleshooting)।
- मॉडल प्रदाताओं का दस्तावेज़ीकरण अलग से किया गया है; देखें [Model Providers](/providers/models)।
