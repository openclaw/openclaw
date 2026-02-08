---
summary: "Telegram allowlist सुदृढ़ीकरण: प्रीफ़िक्स + व्हाइटस्पेस सामान्यीकरण"
read_when:
  - ऐतिहासिक Telegram allowlist परिवर्तनों की समीक्षा करते समय
title: "Telegram Allowlist सुदृढ़ीकरण"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:08Z
---

# Telegram Allowlist सुदृढ़ीकरण

**तिथि**: 2026-01-05  
**स्थिति**: पूर्ण  
**PR**: #216

## सारांश

Telegram allowlists अब `telegram:` और `tg:` प्रीफ़िक्स को केस-असंवेदनशील रूप से स्वीकार करते हैं, और
अनजाने व्हाइटस्पेस को सहन करते हैं। यह इनबाउंड allowlist जाँचों को आउटबाउंड सेंड सामान्यीकरण के अनुरूप करता है।

## क्या बदला

- प्रीफ़िक्स `telegram:` और `tg:` को समान माना जाता है (केस-असंवेदनशील)।
- Allowlist प्रविष्टियाँ ट्रिम की जाती हैं; खाली प्रविष्टियों को अनदेखा किया जाता है।

## उदाहरण

इन सभी को एक ही ID के लिए स्वीकार किया जाता है:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## यह क्यों महत्वपूर्ण है

लॉग्स या चैट IDs से कॉपी/पेस्ट करने पर अक्सर प्रीफ़िक्स और व्हाइटस्पेस शामिल हो जाते हैं। सामान्यीकरण
DMs या समूहों में प्रतिक्रिया देने का निर्णय लेते समय होने वाले गलत नकारात्मक परिणामों से बचाता है।

## संबंधित दस्तावेज़

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
