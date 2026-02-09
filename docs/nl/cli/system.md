---
summary: "CLI-referentie voor `openclaw system` (systeemgebeurtenissen, heartbeat, aanwezigheid)"
read_when:
  - Je wilt een systeemgebeurtenis in de wachtrij plaatsen zonder een cronjob te maken
  - Je moet heartbeat-signalen in- of uitschakelen
  - Je wilt systeemaanwezigheidsvermeldingen inspecteren
title: "systeem"
---

# `openclaw system`

Helpers op systeemniveau voor de Gateway: systeemgebeurtenissen in de wachtrij plaatsen, heartbeat-signalen beheren
en aanwezigheid bekijken.

## Veelgebruikte opdrachten

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Plaats een systeemgebeurtenis in de wachtrij op de **main**-sessie. De volgende heartbeat zal
deze injecteren als een `System:`-regel in de prompt. Gebruik `--mode now` om de heartbeat
onmiddellijk te activeren; `next-heartbeat` wacht op de volgende geplande tick.

Flags:

- `--text <text>`: vereiste tekst voor de systeemgebeurtenis.
- `--mode <mode>`: `now` of `next-heartbeat` (standaard).
- `--json`: machineleesbare uitvoer.

## `system heartbeat last|enable|disable`

Heartbeat-bediening:

- `last`: toon de laatste heartbeat-gebeurtenis.
- `enable`: zet heartbeat-signalen weer aan (gebruik dit als ze waren uitgeschakeld).
- `disable`: pauzeer heartbeat-signalen.

Flags:

- `--json`: machineleesbare uitvoer.

## `system presence`

Toon de huidige systeemaanwezigheidsvermeldingen die de Gateway kent (nodes,
instanties en vergelijkbare statusregels).

Flags:

- `--json`: machineleesbare uitvoer.

## Notities

- Vereist een draaiende Gateway die bereikbaar is via je huidige config (lokaal of op afstand).
- Systeemgebeurtenissen zijn tijdelijk en worden niet bewaard na herstarts.
