---
title: आउटबाउंड सत्र मिररिंग रिफ़ैक्टर (Issue #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
x-i18n:
  source_path: refactor/outbound-session-mirroring.md
  source_hash: b88a72f36f7b6d8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:47Z
---

# आउटबाउंड सत्र मिररिंग रिफ़ैक्टर (Issue #1520)

## स्थिति

- प्रगति में।
- आउटबाउंड मिररिंग के लिए कोर + प्लगइन चैनल रूटिंग अपडेट की गई।
- Gateway send अब sessionKey छोड़े जाने पर लक्ष्य सत्र व्युत्पन्न करता है।

## संदर्भ

आउटबाउंड भेजों को लक्ष्य चैनल सत्र के बजाय _वर्तमान_ एजेंट सत्र (टूल सत्र कुंजी) में मिरर किया जा रहा था। इनबाउंड रूटिंग चैनल/पीयर सत्र कुंजियों का उपयोग करती है, इसलिए आउटबाउंड प्रतिक्रियाएँ गलत सत्र में पहुँचती थीं और प्रथम-संपर्क लक्ष्यों में अक्सर सत्र प्रविष्टियाँ नहीं होती थीं।

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

- **Gateway send सत्र व्युत्पत्ति**: यदि `sessionKey` प्रदान किया गया है, तो उसका उपयोग करें। यदि छोड़ा गया है, तो लक्ष्य + डिफ़ॉल्ट एजेंट से sessionKey व्युत्पन्न करें और वहीं मिरर करें।
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

- वॉइस-कॉल प्लगइन कस्टम `voice:<phone>` सत्र कुंजियों का उपयोग करता है। यहाँ आउटबाउंड मैपिंग मानकीकृत नहीं है; यदि message-tool को वॉइस-कॉल भेजों का समर्थन करना चाहिए, तो स्पष्ट मैपिंग जोड़ें।
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
