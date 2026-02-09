---
summary: "CLI-reference for `openclaw status` (diagnostik, prober, brugssnapshots)"
read_when:
  - Du vil have en hurtig diagnose af kanaltilstand + nylige sessionsmodtagere
  - Du vil have en indsættelig “all”-status til fejlfinding
title: "status"
---

# `openclaw status`

Diagnostik for kanaler + sessioner.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Noter:

- `--deep` kører live-prober (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Output inkluderer sessionslagre pr. agent, når flere agenter er konfigureret.
- Overblikket inkluderer Gateway + node-værtstjenestens installations-/kørselsstatus, når den er tilgængelig.
- Overblikket inkluderer opdateringskanal + git SHA (for kildecheckouts).
- Opdateringsinfo vises i Overblikket; hvis en opdatering er tilgængelig, udskriver status et hint om at køre `openclaw update` (se [Opdatering](/install/updating)).
