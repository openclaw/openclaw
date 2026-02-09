---
summary: "Semantyka reakcji współdzielona między kanałami"
read_when:
  - Praca nad reakcjami w dowolnym kanale
title: "Reakcje"
---

# Narzędzia reakcji

Wspólna semantyka reakcji między kanałami:

- `emoji` jest wymagane podczas dodawania reakcji.
- `emoji=""` usuwa reakcje bota, gdy jest to obsługiwane.
- `remove: true` usuwa wskazany emoji, gdy jest to obsługiwane (wymaga `emoji`).

Uwagi dotyczące kanałów:

- **Discord/Slack**: puste `emoji` usuwa wszystkie reakcje bota na wiadomości; `remove: true` usuwa tylko ten emoji.
- **Google Chat**: puste `emoji` usuwa reakcje aplikacji na wiadomości; `remove: true` usuwa tylko ten emoji.
- **Telegram**: puste `emoji` usuwa reakcje bota; `remove: true` również usuwa reakcje, ale nadal wymaga niepustego `emoji` do walidacji narzędzia.
- **WhatsApp**: puste `emoji` usuwa reakcję bota; `remove: true` mapuje na pusty emoji (nadal wymaga `emoji`).
- **Signal**: przychodzące powiadomienia o reakcjach emitują zdarzenia systemowe, gdy włączone jest `channels.signal.reactionNotifications`.
