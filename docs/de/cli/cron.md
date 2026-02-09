---
summary: "CLI-Referenz für `openclaw cron` (Hintergrundjobs planen und ausführen)"
read_when:
  - Sie möchten geplante Jobs und Wakeups verwenden
  - Sie debuggen die Ausführung von Cron-Jobs und Logs
title: "cron"
---

# `openclaw cron`

Verwalten Sie Cron-Jobs für den Gateway-Scheduler.

Verwandt:

- Cron-Jobs: [Cron jobs](/automation/cron-jobs)

Tipp: Führen Sie `openclaw cron --help` aus, um die vollständige Befehlsoberfläche zu sehen.

Hinweis: Isolierte `cron add`-Jobs verwenden standardmäßig die Zustellung `--announce`. Verwenden Sie `--no-deliver`, um
die Ausgabe intern zu halten. `--deliver` bleibt als veralteter Alias für `--announce` bestehen.

Hinweis: Einmalige (`--at`) Jobs werden standardmäßig nach erfolgreicher Ausführung gelöscht. Verwenden Sie `--keep-after-run`, um sie zu behalten.

Hinweis: Wiederkehrende Jobs verwenden nun nach aufeinanderfolgenden Fehlern ein exponentielles Retry-Backoff (30 s → 1 min → 5 min → 15 min → 60 min) und kehren nach der nächsten erfolgreichen Ausführung zum normalen Zeitplan zurück.

## Häufige Änderungen

Zustellungseinstellungen aktualisieren, ohne die Nachricht zu ändern:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Zustellung für einen isolierten Job deaktivieren:

```bash
openclaw cron edit <job-id> --no-deliver
```

An einen bestimmten Kanal ankündigen:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
