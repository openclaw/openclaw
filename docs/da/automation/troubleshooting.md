---
summary: "Fejlfinding af planlægning og levering for cron og heartbeat"
read_when:
  - Cron blev ikke kørt
  - Cron kørte, men ingen besked blev leveret
  - Heartbeat virker tavs eller sprunget over
title: "Fejlfinding af automatisering"
---

# Fejlfinding af automatisering

Brug denne side til problemer med planlægning og levering (`cron` + `heartbeat`).

## Kommandotrin

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Kør derefter automatiseringstjek:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron affyres ikke

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Godt output ser sådan ud:

- `cron status` rapporterer aktiveret og en fremtidig `nextWakeAtMs`.
- Jobbet er aktiveret og har en gyldig tidsplan/tidszone.
- `cron runs` viser `ok` eller en eksplicit spring-over-årsag.

Almindelige signaturer:

- `cron: scheduler disabled; jobs will not run automatically` → cron deaktiveret i konfiguration/miljø.
- `cron: timer tick failed` → scheduler-tick crashede; inspicér omkringliggende stack/log-kontekst.
- `reason: not-due` i kørseloutput → manuel kørsel kaldt uden `--force`, og jobbet er endnu ikke forfaldent.

## Cron affyrede, men ingen levering

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Godt output ser sådan ud:

- Kørselstatus er `ok`.
- Leveringstilstand/-mål er sat for isolerede jobs.
- Kanalprobe rapporterer, at målkanalen er forbundet.

Almindelige signaturer:

- Kørsel lykkedes, men leveringstilstanden er `none` → ingen ekstern besked forventes.
- Leveringsmål mangler/er ugyldigt (`channel`/`to`) → kørsel kan lykkes internt, men springer udgående over.
- Kanal-autentificeringsfejl (`unauthorized`, `missing_scope`, `Forbidden`) → levering blokeret af kanallegitimationsoplysninger/-tilladelser.

## Heartbeat undertrykt eller sprunget over

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Godt output ser sådan ud:

- Heartbeat aktiveret med ikke-nul interval.
- Seneste heartbeat-resultat er `ran` (eller spring-over-årsagen er forstået).

Almindelige signaturer:

- `heartbeat skipped` med `reason=quiet-hours` → uden for `activeHours`.
- `requests-in-flight` → hovedsporet er optaget; heartbeat udsat.
- `empty-heartbeat-file` → `HEARTBEAT.md` findes, men har intet handlingsbart indhold.
- `alerts-disabled` → synlighedsindstillinger undertrykker udgående heartbeat-beskeder.

## Faldgruber ved tidszone og activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Hurtige regler:

- `Config path not found: agents.defaults.userTimezone` betyder, at nøglen ikke er sat; heartbeat falder tilbage til værts-tidszonen (eller `activeHours.timezone` hvis sat).
- Cron uden `--tz` bruger gateway-værtens tidszone.
- Heartbeat `activeHours` bruger konfigureret tidszoneopslag (`user`, `local` eller eksplicit IANA-tz).
- ISO-tidsstempler uden tidszone behandles som UTC for cron `at`-planer.

Almindelige signaturer:

- Jobs kører på forkert klokkeslæt efter ændringer i værts-tidszonen.
- Heartbeat springes altid over i din dagtimer, fordi `activeHours.timezone` er forkert.

Relateret:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
