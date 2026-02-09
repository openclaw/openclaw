---
summary: "Reaktionssemantik, die kanalübergreifend geteilt wird"
read_when:
  - Bei der Arbeit mit Reaktionen in jedem Kanal
title: "Reaktionen"
---

# Reaktions-Tooling

Geteilte Reaktionssemantik über alle Kanäle hinweg:

- `emoji` ist erforderlich, wenn eine Reaktion hinzugefügt wird.
- `emoji=""` entfernt die Reaktion(en) des Bots, sofern unterstützt.
- `remove: true` entfernt das angegebene Emoji, sofern unterstützt (erfordert `emoji`).

Kanalspezifische Hinweise:

- **Discord/Slack**: Ein leeres `emoji` entfernt alle Reaktionen des Bots auf der Nachricht; `remove: true` entfernt nur dieses Emoji.
- **Google Chat**: Ein leeres `emoji` entfernt die Reaktionen der App auf der Nachricht; `remove: true` entfernt nur dieses Emoji.
- **Telegram**: Ein leeres `emoji` entfernt die Reaktionen des Bots; `remove: true` entfernt ebenfalls Reaktionen, erfordert jedoch weiterhin ein nicht leeres `emoji` für die Werkzeugvalidierung.
- **WhatsApp**: Ein leeres `emoji` entfernt die Reaktion des Bots; `remove: true` wird auf ein leeres Emoji abgebildet (erfordert weiterhin `emoji`).
- **Signal**: Eingehende Reaktionsbenachrichtigungen erzeugen Systemereignisse, wenn `channels.signal.reactionNotifications` aktiviert ist.
