---
summary: "Reactiesemantiek gedeeld over kanalen"
read_when:
  - Werken aan reacties in elk kanaal
title: "Reacties"
---

# Reactie-tooling

Gedeelde reactiesemantiek over kanalen:

- `emoji` is vereist bij het toevoegen van een reactie.
- `emoji=""` verwijdert de reactie(s) van de bot wanneer ondersteund.
- `remove: true` verwijdert de opgegeven emoji wanneer ondersteund (vereist `emoji`).

Kanaalnotities:

- **Discord/Slack**: een lege `emoji` verwijdert alle reacties van de bot op het bericht; `remove: true` verwijdert alleen die emoji.
- **Google Chat**: een lege `emoji` verwijdert de reacties van de app op het bericht; `remove: true` verwijdert alleen die emoji.
- **Telegram**: een lege `emoji` verwijdert de reacties van de bot; `remove: true` verwijdert ook reacties maar vereist nog steeds een niet-lege `emoji` voor toolvalidatie.
- **WhatsApp**: een lege `emoji` verwijdert de botreactie; `remove: true` wordt gemapt naar een lege emoji (vereist nog steeds `emoji`).
- **Signal**: inkomende reactiemeldingen genereren systeemevents wanneer `channels.signal.reactionNotifications` is ingeschakeld.
