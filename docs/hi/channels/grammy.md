---
summary: "grammY के माध्यम से Telegram Bot API एकीकरण, सेटअप नोट्स सहित"
read_when:
  - Telegram या grammY पाथवे पर कार्य करते समय
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:52Z
---

# grammY एकीकरण (Telegram Bot API)

# grammY क्यों

- TS-प्रथम Bot API क्लाइंट, जिसमें अंतर्निहित long-poll + webhook सहायक, मिडलवेयर, त्रुटि प्रबंधन, और रेट लिमिटर शामिल हैं।
- fetch + FormData को स्वयं तैयार करने की तुलना में अधिक स्वच्छ मीडिया सहायक; सभी Bot API मेथड्स का समर्थन करता है।
- विस्तार योग्य: कस्टम fetch के माध्यम से प्रॉक्सी समर्थन, सेशन मिडलवेयर (वैकल्पिक), टाइप-सुरक्षित कॉन्टेक्स्ट।

# हमने क्या शिप किया

- **एकल क्लाइंट पाथ:** fetch-आधारित इम्प्लीमेंटेशन हटा दिया गया; grammY अब एकमात्र Telegram क्लाइंट (send + Gateway) है, और grammY throttler डिफ़ॉल्ट रूप से सक्षम है।
- **Gateway:** `monitorTelegramProvider` एक grammY `Bot` बनाता है, मेंशन/allowlist गेटिंग को वायर करता है, `getFile`/`download` के माध्यम से मीडिया डाउनलोड करता है, और `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` के साथ उत्तर भेजता है। `webhookCallback` के माध्यम से long-poll या webhook का समर्थन करता है।
- **प्रॉक्सी:** वैकल्पिक `channels.telegram.proxy` grammY के `client.baseFetch` के माध्यम से `undici.ProxyAgent` का उपयोग करता है।
- **Webhook समर्थन:** `webhook-set.ts`, `setWebhook/deleteWebhook` को रैप करता है; `webhook.ts` स्वास्थ्य जांच + graceful shutdown के साथ callback होस्ट करता है। जब `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` सेट होते हैं, Gateway webhook मोड सक्षम करता है (अन्यथा यह long-poll करता है)।
- **सेशन्स:** डायरेक्ट चैट्स एजेंट के मुख्य सत्र (`agent:<agentId>:<mainKey>`) में समाहित हो जाती हैं; समूह `agent:<agentId>:telegram:group:<chatId>` का उपयोग करते हैं; उत्तर उसी चैनल पर वापस रूट होते हैं।
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention डिफ़ॉल्ट्स), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`।
- **ड्राफ्ट स्ट्रीमिंग:** वैकल्पिक `channels.telegram.streamMode` निजी टॉपिक चैट्स में `sendMessageDraft` का उपयोग करता है (Bot API 9.3+)। यह चैनल ब्लॉक स्ट्रीमिंग से अलग है।
- **टेस्ट्स:** grammY मॉक DM + समूह मेंशन गेटिंग और आउटबाउंड सेंड को कवर करते हैं; अधिक मीडिया/webhook फिक्स्चर अभी भी स्वागत योग्य हैं।

खुले प्रश्न

- यदि Bot API 429s का सामना होता है, तो वैकल्पिक grammY प्लगइन्स (throttler)।
- अधिक संरचित मीडिया टेस्ट्स जोड़ना (स्टिकर्स, वॉइस नोट्स)।
- webhook listen पोर्ट को विन्यास योग्य बनाना (वर्तमान में Gateway के माध्यम से वायर न होने पर 8787 पर स्थिर)।
