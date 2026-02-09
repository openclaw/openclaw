---
summary: "Felsök schemaläggning och leverans för cron och heartbeat"
read_when:
  - Cron kördes inte
  - Cron kördes men inget meddelande levererades
  - Heartbeat verkar tyst eller hoppades över
title: "Felsökning av automatisering"
---

# Felsökning av automatisering

Använd den här sidan för problem med schemaläggning och leverans (`cron` + `heartbeat`).

## Kommandokedja

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Kör sedan automatiseringskontroller:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron triggas inte

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Bra utdata ser ut så här:

- `cron status` rapporterar aktiverad och en framtida `nextWakeAtMs`.
- Jobbet är aktiverat och har ett giltigt schema/tidszon.
- `cron runs` visar `ok` eller en explicit orsak till att det hoppades över.

Vanliga signaturer:

- `cron: scheduler disabled; jobs will not run automatically` → cron inaktiverad i konfig/env.
- `cron: timer tick failed` → schemaläggarens tick kraschade; granska omgivande stack-/loggkontext.
- `reason: not-due` i körutdata → manuell körning anropades utan `--force` och jobbet var ännu inte förfallet.

## Cron triggas men ingen leverans

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Bra utdata ser ut så här:

- Körstatus är `ok`.
- Leveransläge/mål är inställda för isolerade jobb.
- Kanalproben rapporterar att målkanalen är ansluten.

Vanliga signaturer:

- Körningen lyckades men leveransläget är `none` → inget externt meddelande förväntas.
- Leveransmål saknas/är ogiltigt (`channel`/`to`) → körningen kan lyckas internt men utgående leverans hoppas över.
- Kanalautentiseringsfel (`unauthorized`, `missing_scope`, `Forbidden`) → leverans blockeras av kanalens autentiseringsuppgifter/behörigheter.

## Heartbeat undertryckt eller hoppad över

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Bra utdata ser ut så här:

- Heartbeat är aktiverad med ett intervall som inte är noll.
- Senaste heartbeat-resultatet är `ran` (eller så är orsaken till att det hoppades över känd).

Vanliga signaturer:

- `heartbeat skipped` med `reason=quiet-hours` → utanför `activeHours`.
- `requests-in-flight` → huvudkörfältet är upptaget; heartbeat skjuts upp.
- `empty-heartbeat-file` → `HEARTBEAT.md` finns men saknar åtgärdsbart innehåll.
- `alerts-disabled` → synlighetsinställningar undertrycker utgående heartbeat-meddelanden.

## Tidszon- och activeHours-fällor

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Snabba regler:

- `Config path not found: agents.defaults.userTimezone` betyder att nyckeln är oinställd; heartbeat faller tillbaka till värdens tidszon (eller `activeHours.timezone` om den är satt).
- Cron utan `--tz` använder gateway-värdens tidszon.
- Heartbeat `activeHours` använder konfigurerad tidszonsupplösning (`user`, `local` eller explicit IANA-tz).
- ISO-tidsstämplar utan tidszon behandlas som UTC för cron `at`-scheman.

Vanliga signaturer:

- Jobb körs vid fel klockslag efter ändringar av värdens tidszon.
- Heartbeat hoppas alltid över under din dagtid eftersom `activeHours.timezone` är fel.

Relaterat:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
