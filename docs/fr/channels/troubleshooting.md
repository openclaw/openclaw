---
summary: "Raccourcis de depannage specifiques aux canaux (Discord/Telegram/WhatsApp)"
read_when:
  - Un canal se connecte mais les messages ne circulent pas
  - Enquete sur une mauvaise configuration du canal (intents, permissions, mode de confidentialite)
title: "Depannage des canaux"
x-i18n:
  source_path: channels/troubleshooting.md
  source_hash: 6542ee86b3e50929
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:00:42Z
---

# Depannage des canaux

Commencez par :

```bash
openclaw doctor
openclaw channels status --probe
```

`channels status --probe` affiche des avertissements lorsqu’il peut detecter des mauvaises configurations courantes de canal, et inclut de petits controles en direct (identifiants, certaines permissions/appartenances).

## Canaux

- Discord : [/channels/discord#troubleshooting](/channels/discord#troubleshooting)
- Telegram : [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)
- WhatsApp : [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Correctifs rapides Telegram

- Les journaux affichent `HttpError: Network request for 'sendMessage' failed` ou `sendChatAction` → verifiez le DNS IPv6. Si `api.telegram.org` se resout d’abord en IPv6 et que l’hote ne dispose pas de sortie IPv6, forcez IPv4 ou activez IPv6. Voir [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting).
- Les journaux affichent `setMyCommands failed` → verifiez la connectivite HTTPS sortante et la joignabilite DNS vers `api.telegram.org` (courant sur des VPS verrouilles ou des proxys).
