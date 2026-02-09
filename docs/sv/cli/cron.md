---
summary: "CLI-referens för `openclaw cron` (schemalägg och kör bakgrundsjobb)"
read_when:
  - Du vill ha schemalagda jobb och väckningar
  - Du felsöker cron-körning och loggar
title: "cron"
---

# `openclaw cron`

Hantera cron-jobb för Gateway-schemaläggaren.

Relaterat:

- Cron-jobb: [Cron jobs](/automation/cron-jobs)

Tips: kör `openclaw cron --help` för hela kommandoytan.

Obs: isolerade `cron add`-jobb standard till `--announce`-leverans. Använd `--no-deliver` för att hålla
utdata internt. `--deliver` förblir som ett föråldrat alias för `--announce`.

Obs: one-shot (`--at`) jobb ta bort efter framgång som standard. Använd `--keep-after-run` för att behålla dem.

Obs: återkommande jobb använder nu exponentiell återförsöksbackoff efter på varandra följande fel (30s → 1m → 5m → 15m → 60m) och återgår sedan till normalt schema efter nästa lyckade körning.

## Vanliga ändringar

Uppdatera leveransinställningar utan att ändra meddelandet:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Inaktivera leverans för ett isolerat jobb:

```bash
openclaw cron edit <job-id> --no-deliver
```

Meddela till en specifik kanal:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
