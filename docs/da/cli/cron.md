---
summary: "CLI-reference for `openclaw cron` (planlæg og kør baggrundsjob)"
read_when:
  - Du vil have planlagte job og wakeups
  - Du fejlretter cron-udførelse og logs
title: "cron"
---

# `openclaw cron`

Administrér cron-jobs for Gateway-scheduleren.

Relateret:

- Cron-jobs: [Cron jobs](/automation/cron-jobs)

Tip: kør `openclaw cron --help` for den fulde kommandoflade.

Bemærk: isoleret `cron add` job standard til `--announce` levering. Brug `--no-deliver` for at holde
output internt. `--deliver` forbliver som et forældet alias for `--announce`.

Bemærk: one-shot (`--at`) job slet efter succes som standard. Brug `-- keep-after-run` for at holde dem.

Note: tilbagevendende job bruger nu eksponentiel retry-backoff efter på hinanden følgende fejl (30s → 1m → 5m → 15m → 60m) og vender derefter tilbage til den normale tidsplan efter den næste vellykkede kørsel.

## Almindelige ændringer

Opdatér leveringsindstillinger uden at ændre beskeden:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Deaktivér levering for et isoleret job:

```bash
openclaw cron edit <job-id> --no-deliver
```

Annoncér til en specifik kanal:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
