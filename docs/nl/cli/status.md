---
summary: "CLI-referentie voor `openclaw status` (diagnostiek, probes, gebruikssnapshots)"
read_when:
  - Je wilt een snelle diagnose van kanaalstatus + recente sessie-ontvangers
  - Je wilt een plakklare “alles”-status voor debugging
title: "status"
---

# `openclaw status`

Diagnostiek voor kanalen + sessies.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Notities:

- `--deep` voert live probes uit (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Uitvoer bevat per agent sessie-opslag wanneer meerdere agents zijn geconfigureerd.
- Het overzicht bevat de installatiestatus en runtime-status van Gateway + node-hostservice wanneer beschikbaar.
- Het overzicht bevat het updatekanaal + git SHA (voor broncheckouts).
- Update-informatie verschijnt in het overzicht; als er een update beschikbaar is, toont de status een hint om `openclaw update` uit te voeren (zie [Bijwerken](/install/updating)).
