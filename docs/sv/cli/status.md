---
summary: "CLI-referens för `openclaw status` (diagnostik, prober, användningsögonblicksbilder)"
read_when:
  - Du vill ha en snabb diagnos av kanalhälsa + senaste sessionsmottagare
  - Du vill ha en inklistringsbar ”all”-status för felsökning
title: "status"
x-i18n:
  source_path: cli/status.md
  source_hash: 2bbf5579c48034fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:49Z
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
