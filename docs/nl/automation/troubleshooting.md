---
summary: "Problemen oplossen met cron- en heartbeatplanning en -bezorging"
read_when:
  - Cron is niet uitgevoerd
  - Cron is uitgevoerd maar er is geen bericht afgeleverd
  - Heartbeat lijkt stil of overgeslagen
title: "Problemen oplossen bij automatisering"
---

# Problemen oplossen bij automatisering

Gebruik deze pagina voor problemen met planning en bezorging (`cron` + `heartbeat`).

## Opdrachtenladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Voer daarna automatiseringscontroles uit:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron start niet

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Goede uitvoer ziet er zo uit:

- `cron status` meldt ingeschakeld en een toekomstige `nextWakeAtMs`.
- De job is ingeschakeld en heeft een geldig schema/tijdzone.
- `cron runs` toont `ok` of een expliciete reden voor overslaan.

Veelvoorkomende signalen:

- `cron: scheduler disabled; jobs will not run automatically` → cron uitgeschakeld in config/omgeving.
- `cron: timer tick failed` → scheduler-tick gecrasht; inspecteer omliggende stack-/logcontext.
- `reason: not-due` in uitvoer van een run → handmatige run aangeroepen zonder `--force` en de job is nog niet aan de beurt.

## Cron uitgevoerd maar geen bezorging

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Goede uitvoer ziet er zo uit:

- Runstatus is `ok`.
- Bezorgmodus/doel zijn ingesteld voor geïsoleerde jobs.
- Kanaalprobe meldt dat het doelkanaal is verbonden.

Veelvoorkomende signalen:

- Run geslaagd maar bezorgmodus is `none` → er wordt geen extern bericht verwacht.
- Bezorgdoel ontbreekt/ongeldig (`channel`/`to`) → run kan intern slagen maar uitgaande bezorging overslaan.
- Kanaalautorisatiefouten (`unauthorized`, `missing_scope`, `Forbidden`) → bezorging geblokkeerd door kanaalreferenties/rechten.

## Heartbeat onderdrukt of overgeslagen

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Goede uitvoer ziet er zo uit:

- Heartbeat ingeschakeld met een niet-nul interval.
- Laatste heartbeatresultaat is `ran` (of de reden voor overslaan is bekend).

Veelvoorkomende signalen:

- `heartbeat skipped` met `reason=quiet-hours` → buiten `activeHours`.
- `requests-in-flight` → hoofdlane bezig; heartbeat uitgesteld.
- `empty-heartbeat-file` → `HEARTBEAT.md` bestaat maar bevat geen actiegerichte inhoud.
- `alerts-disabled` → zichtbaarheidsinstellingen onderdrukken uitgaande heartbeatberichten.

## Valkuilen met tijdzone en activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Snelle regels:

- `Config path not found: agents.defaults.userTimezone` betekent dat de sleutel niet is ingesteld; heartbeat valt terug op de hosttijdzone (of `activeHours.timezone` indien ingesteld).
- Cron zonder `--tz` gebruikt de tijdzone van de Gateway-host.
- Heartbeat `activeHours` gebruikt de geconfigureerde tijdzone-resolutie (`user`, `local` of expliciete IANA-tz).
- ISO-tijdstempels zonder tijdzone worden voor cron-`at`-schema’s behandeld als UTC.

Veelvoorkomende signalen:

- Jobs draaien op het verkeerde kloktijdstip na wijzigingen aan de hosttijdzone.
- Heartbeat wordt overdag altijd overgeslagen omdat `activeHours.timezone` onjuist is.

Gerelateerd:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
