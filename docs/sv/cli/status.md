---
summary: "CLI-referens för `openclaw status` (diagnostik, prober, användningsögonblicksbilder)"
read_when:
  - Du vill ha en snabb diagnos av kanalhälsa + senaste sessionsmottagare
  - Du vill ha en inklistringsbar ”all”-status för felsökning
title: "status"
---

# `openclaw status`

Diagnostik för kanaler + sessioner.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Noteringar:

- `--deep` kör liveprober (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Utdata inkluderar sessionslagring per agent när flera agenter är konfigurerade.
- Översikten inkluderar installations-/körtidsstatus för Gateway + node host-tjänsten när tillgängligt.
- Översikten inkluderar uppdateringskanal + git SHA (för källutcheckningar).
- Uppdateringsinformation visas i översikten; om en uppdatering är tillgänglig skriver status ut en hint om att köra `openclaw update` (se [Updating](/install/updating)).
