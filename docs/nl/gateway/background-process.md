---
summary: "Uitvoering van achtergrond-exec en procesbeheer"
read_when:
  - Achtergrond-exec-gedrag toevoegen of wijzigen
  - Debuggen van langlopende exec-taken
title: "Achtergrond Exec en Proces-tool"
---

# Achtergrond Exec + Proces-tool

OpenClaw voert shell-opdrachten uit via de `exec`-tool en houdt langlopende taken in het geheugen. De `process`-tool beheert die achtergrondsessies.

## exec-tool

Belangrijkste parameters:

- `command` (vereist)
- `yieldMs` (standaard 10000): automatisch naar de achtergrond na deze vertraging
- `background` (bool): direct naar de achtergrond
- `timeout` (seconden, standaard 1800): beëindig het proces na deze time-out
- `elevated` (bool): uitvoeren op de host als verhoogde modus is ingeschakeld/toegestaan
- Echte TTY nodig? Stel `pty: true` in.
- `workdir`, `env`

Gedrag:

- Foreground-uitvoeringen geven uitvoer direct terug.
- Wanneer naar de achtergrond verplaatst (expliciet of via time-out), retourneert de tool `status: "running"` + `sessionId` en een korte tail.
- Uitvoer blijft in het geheugen totdat de sessie wordt gepolld of gewist.
- Als de `process`-tool niet is toegestaan, draait `exec` synchroon en negeert `yieldMs`/`background`.

## Child-process bridging

Bij het starten van langlopende child-processen buiten de exec/proces-tools (bijvoorbeeld CLI-herstarts of Gateway-helpers), koppel de child-process bridge helper zodat beëindigingssignalen worden doorgestuurd en listeners worden losgekoppeld bij exit/fout. Dit voorkomt verweesde processen op systemd en houdt het afsluitgedrag consistent over platforms heen.

Omgevingsoverschrijvingen:

- `PI_BASH_YIELD_MS`: standaard yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: in-memory uitvoerlimiet (tekens)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: limiet voor wachtende stdout/stderr per stream (tekens)
- `PI_BASH_JOB_TTL_MS`: TTL voor voltooide sessies (ms, begrensd tot 1m–3u)

Config (aanbevolen):

- `tools.exec.backgroundMs` (standaard 10000)
- `tools.exec.timeoutSec` (standaard 1800)
- `tools.exec.cleanupMs` (standaard 1800000)
- `tools.exec.notifyOnExit` (standaard true): plaats een systeemevent in de wachtrij + vraag een heartbeat aan wanneer een naar de achtergrond verplaatste exec eindigt.

## process-tool

Acties:

- `list`: actieve + voltooide sessies
- `poll`: nieuwe uitvoer voor een sessie leegtrekken (rapporteert ook exitstatus)
- `log`: de geaggregeerde uitvoer lezen (ondersteunt `offset` + `limit`)
- `write`: stdin verzenden (`data`, optioneel `eof`)
- `kill`: een achtergrondsessie beëindigen
- `clear`: een voltooide sessie uit het geheugen verwijderen
- `remove`: doden indien actief, anders wissen indien voltooid

Notities:

- Alleen sessies die naar de achtergrond zijn verplaatst, worden vermeld/opgeslagen in het geheugen.
- Sessies gaan verloren bij een procesherstart (geen persistente opslag op schijf).
- Sessielogs worden alleen opgeslagen in de chatgeschiedenis als je `process poll/log` uitvoert en het toolresultaat wordt vastgelegd.
- `process` is per agent gescopeerd; het ziet alleen sessies die door die agent zijn gestart.
- `process list` bevat een afgeleide `name` (commandowerkwoord + doel) voor snelle scans.
- `process log` gebruikt regelgebaseerde `offset`/`limit` (laat `offset` weg om de laatste N regels te pakken).

## Voorbeelden

Een lange taak uitvoeren en later pollen:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Direct op de achtergrond starten:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Stdin verzenden:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
