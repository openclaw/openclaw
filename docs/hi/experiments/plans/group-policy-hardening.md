---
summary: "Telegram allowlist सुदृढ़ीकरण: प्रीफ़िक्स + व्हाइटस्पेस सामान्यीकरण"
read_when:
  - ऐतिहासिक Telegram allowlist परिवर्तनों की समीक्षा करते समय
title: "Telegram Allowlist सुदृढ़ीकरण"
---

# Telegram Allowlist सुदृढ़ीकरण

**तिथि**: 2026-01-05  
**स्थिति**: पूर्ण  
**PR**: #216

## सारांश

32. Telegram allowlists अब `telegram:` और `tg:` prefixes को case‑insensitively स्वीकार करते हैं, और
    accidental whitespace को सहन करते हैं। 33. यह inbound allowlist checks को outbound send normalization के साथ align करता है।

## क्या बदला

- प्रीफ़िक्स `telegram:` और `tg:` को समान माना जाता है (केस-असंवेदनशील)।
- Allowlist प्रविष्टियाँ ट्रिम की जाती हैं; खाली प्रविष्टियों को अनदेखा किया जाता है।

## उदाहरण

इन सभी को एक ही ID के लिए स्वीकार किया जाता है:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## यह क्यों महत्वपूर्ण है

34. Logs या chat IDs से copy/paste करने पर अक्सर prefixes और whitespace शामिल हो जाते हैं। 35. Normalizing से
    DMs या groups में जवाब देना है या नहीं तय करते समय false negatives से बचाव होता है।

## संबंधित दस्तावेज़

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
