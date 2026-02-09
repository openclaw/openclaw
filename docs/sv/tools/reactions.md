---
summary: "Reaktionssemantik som delas över kanaler"
read_when:
  - Arbetar med reaktioner i valfri kanal
title: "Reaktioner"
---

# Reaktionsverktyg

Delad reaktionssemantik över kanaler:

- `emoji` krävs när du lägger till en reaktion.
- `emoji=""` tar bort botens reaktion(er) när det stöds.
- `remove: true` tar bort den angivna emojin när det stöds (kräver `emoji`).

Kanalnoteringar:

- **Discord/Slack**: tom `emoji` tar bort alla botens reaktioner på meddelandet; `remove: true` tar bort endast den emojin.
- **Google Chat**: tom `emoji` tar bort appens reaktioner på meddelandet; `remove: true` tar bort endast den emojin.
- **Telegram**: tom `emoji` tar bort botens reaktioner; `remove: true` tar också bort reaktioner men kräver fortfarande ett icke-tomt `emoji` för verktygsvalidering.
- **WhatsApp**: tom `emoji` tar bort botens reaktion; `remove: true` mappas till tom emoji (kräver fortfarande `emoji`).
- **Signal**: inkommande reaktionsaviseringar genererar systemhändelser när `channels.signal.reactionNotifications` är aktiverat.
