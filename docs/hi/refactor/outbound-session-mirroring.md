---
title: "आउटबाउंड सत्र मिररिंग रिफ़ैक्टर (Issue #1520)" #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
---

# आउटबाउंड सत्र मिररिंग रिफ़ैक्टर (Issue #1520)

## स्थिति

- प्रगति में।
- आउटबाउंड मिररिंग के लिए कोर + प्लगइन चैनल रूटिंग अपडेट की गई।
- Gateway send अब sessionKey छोड़े जाने पर लक्ष्य सत्र व्युत्पन्न करता है।

## संदर्भ

Outbound sends were mirrored into the _current_ agent session (tool session key) rather than the target channel session. Inbound routing uses channel/peer session keys, so outbound responses landed in the wrong session and first-contact targets often lacked session entries.

## लक्ष्य

- आउटबाउंड संदेशों को लक्ष्य चैनल सत्र कुंजी में मिरर करना।
- अनुपस्थित होने पर आउटबाउंड पर सत्र प्रविष्टियाँ बनाना।
- थ्रेड/विषय स्कोपिंग को इनबाउंड सत्र कुंजियों के अनुरूप रखना।
- कोर चैनलों के साथ बंडल्ड एक्सटेंशनों को कवर करना।

## कार्यान्वयन सारांश

- नया आउटबाउंड सत्र रूटिंग हेल्पर:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` `buildAgentSessionKey` (dmScope + identityLinks) का उपयोग करके लक्ष्य sessionKey बनाता है।
  - `ensureOutboundSessionEntry` `recordSessionMetaFromInbound` के माध्यम से न्यूनतम `MsgContext` लिखता है।
- `runMessageAction` (send) लक्ष्य sessionKey व्युत्पन्न करता है और मिररिंग के लिए उसे `executeSendAction` को पास करता है।
- `message-tool` अब सीधे मिरर नहीं करता; यह केवल वर्तमान सत्र कुंजी से agentId रेज़ॉल्व करता है।
- प्लगइन send पाथ व्युत्पन्न sessionKey का उपयोग करके `appendAssistantMessageToSessionTranscript` के माध्यम से मिरर करता है।
- Gateway send तब लक्ष्य सत्र कुंजी व्युत्पन्न करता है जब कोई प्रदान न हो (डिफ़ॉल्ट एजेंट), और सत्र प्रविष्टि सुनिश्चित करता है।

## थ्रेड/विषय हैंडलिंग

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (सफ़िक्स)।
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` के साथ `useSuffix=false` ताकि इनबाउंड से मेल खाए (थ्रेड चैनल id पहले से सत्र को स्कोप करता है)।
- Telegram: विषय IDs `buildTelegramGroupPeerId` के माध्यम से `chatId:topic:<id>` में मैप होते हैं।

## कवर किए गए एक्सटेंशन

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon।
- नोट्स:
  - Mattermost लक्ष्य अब DM सत्र कुंजी रूटिंग के लिए `@` हटाते हैं।
  - Zalo Personal 1:1 लक्ष्यों के लिए DM पीयर प्रकार का उपयोग करता है (समूह केवल तब जब `group:` मौजूद हो)।
  - BlueBubbles समूह लक्ष्य इनबाउंड सत्र कुंजियों से मेल करने के लिए `chat_*` प्रीफ़िक्स हटाते हैं।
  - Slack ऑटो-थ्रेड मिररिंग चैनल ids को केस-असंवेदनशील रूप से मिलाती है।
  - Gateway send मिररिंग से पहले प्रदान की गई सत्र कुंजियों को लोअरकेस करता है।

## निर्णय

- **Gateway send session derivation**: if `sessionKey` is provided, use it. If omitted, derive a sessionKey from target + default agent and mirror there.
- **सत्र प्रविष्टि निर्माण**: हमेशा `recordSessionMetaFromInbound` का उपयोग करें, जिसमें `Provider/From/To/ChatType/AccountId/Originating*` इनबाउंड प्रारूपों के अनुरूप हों।
- **लक्ष्य सामान्यीकरण**: आउटबाउंड रूटिंग उपलब्ध होने पर रेज़ॉल्व किए गए लक्ष्यों (post `resolveChannelTarget`) का उपयोग करती है।
- **सत्र कुंजी केसिंग**: लिखते समय और माइग्रेशन के दौरान सत्र कुंजियों को लोअरकेस में कैनोनिकलाइज़ करें।

## जोड़े/अपडेट किए गए परीक्षण

- `src/infra/outbound/outbound-session.test.ts`
  - Slack थ्रेड सत्र कुंजी।
  - Telegram विषय सत्र कुंजी।
  - Discord के साथ dmScope identityLinks।
- `src/agents/tools/message-tool.test.ts`
  - सत्र कुंजी से agentId व्युत्पन्न करता है (कोई sessionKey पास नहीं किया गया)।
- `src/gateway/server-methods/send.test.ts`
  - छोड़े जाने पर सत्र कुंजी व्युत्पन्न करता है और सत्र प्रविष्टि बनाता है।

## खुले आइटम / फॉलो-अप

- Voice-call plugin uses custom `voice:<phone>` session keys. Outbound mapping is not standardized here; if message-tool should support voice-call sends, add explicit mapping.
- पुष्टि करें कि क्या कोई बाहरी प्लगइन बंडल्ड सेट से परे गैर-मानक `From/To` प्रारूपों का उपयोग करता है।

## बदली गई फ़ाइलें

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- परीक्षण:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
