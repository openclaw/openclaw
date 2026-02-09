---
summary: "CLI-referentie voor `openclaw cron` (plannen en uitvoeren van achtergrondtaken)"
read_when:
  - Je wilt geplande taken en wake-ups
  - Je bent bezig met het debuggen van cron-uitvoering en logs
title: "cron"
---

# `openclaw cron`

Beheer cronjobs voor de Gateway-planner.

Gerelateerd:

- Cronjobs: [Cron jobs](/automation/cron-jobs)

Tip: voer `openclaw cron --help` uit voor het volledige opdrachtoppervlak.

Let op: geïsoleerde `cron add`-taken gebruiken standaard `--announce`-levering. Gebruik `--no-deliver` om
uitvoer intern te houden. `--deliver` blijft bestaan als verouderde alias voor `--announce`.

Let op: eenmalige (`--at`) taken worden standaard verwijderd na succes. Gebruik `--keep-after-run` om ze te behouden.

Let op: terugkerende taken gebruiken nu exponentiële retry-backoff na opeenvolgende fouten (30s → 1m → 5m → 15m → 60m) en keren daarna terug naar het normale schema na de eerstvolgende succesvolle uitvoering.

## Veelvoorkomende bewerkingen

Werk leveringsinstellingen bij zonder het bericht te wijzigen:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Schakel levering uit voor een geïsoleerde taak:

```bash
openclaw cron edit <job-id> --no-deliver
```

Kondig aan in een specifiek kanaal:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
