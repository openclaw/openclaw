---
summary: "Kanallar arasında paylaşılan tepki semantiği"
read_when:
  - Herhangi bir kanalda tepkiler üzerinde çalışırken
title: "Tepkiler"
---

# Tepki araçları

Kanallar arasında paylaşılan tepki semantiği:

- Bir tepki eklerken `emoji` gereklidir.
- `emoji=""`, desteklendiğinde botun tepkilerini kaldırır.
- `remove: true`, desteklendiğinde belirtilen emojiyi kaldırır (`emoji` gerektirir).

Kanal notları:

- **Discord/Slack**: boş `emoji`, mesajdaki botun tüm tepkilerini kaldırır; `remove: true` yalnızca o emojiyi kaldırır.
- **Google Chat**: boş `emoji`, mesajdaki uygulamanın tepkilerini kaldırır; `remove: true` yalnızca o emojiyi kaldırır.
- **Telegram**: boş `emoji`, botun tepkilerini kaldırır; `remove: true` da tepkileri kaldırır ancak araç doğrulaması için yine de boş olmayan bir `emoji` gerektirir.
- **WhatsApp**: boş `emoji`, bot tepkisini kaldırır; `remove: true` boş emojiye eşlenir (yine de `emoji` gerektirir).
- **Signal**: gelen tepki bildirimleri, `channels.signal.reactionNotifications` etkinleştirildiğinde sistem olayları üretir.
