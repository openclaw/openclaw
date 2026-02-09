---
summary: "Reaktionssemantik delt på tværs af kanaler"
read_when:
  - Arbejder med reaktioner i enhver kanal
title: "Reaktioner"
---

# Reaktionsværktøjer

Delt reaktionssemantik på tværs af kanaler:

- `emoji` er påkrævet ved tilføjelse af en reaktion.
- `emoji=""` fjerner botens reaktion(er), når det understøttes.
- `remove: true` fjerner den angivne emoji, når det understøttes (kræver `emoji`).

Kanalnoter:

- **Discord/Slack**: tom `emoji` fjerner alle botens reaktioner på beskeden; `remove: true` fjerner kun den pågældende emoji.
- **Google Chat**: tom `emoji` fjerner appens reaktioner på beskeden; `remove: true` fjerner kun den pågældende emoji.
- **Telegram**: tom `emoji` fjerner botens reaktioner; `remove: true` fjerner også reaktioner, men kræver stadig en ikke-tom `emoji` til værktøjsvalidering.
- **WhatsApp**: tom `emoji` fjerner bot-reaktionen; `remove: true` mappes til tom emoji (kræver stadig `emoji`).
- **Signal**: indgående reaktionsnotifikationer udsender systemhændelser, når `channels.signal.reactionNotifications` er aktiveret.
