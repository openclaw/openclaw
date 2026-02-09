---
summary: "Udførelse i baggrunden og processtyring"
read_when:
  - Tilføjelse eller ændring af adfærd for baggrunds-exec
  - Fejlfinding af langvarige exec-opgaver
title: "Background Exec og procesværktøj"
---

# Background Exec + procesværktøj

OpenClaw kører shell kommandoer gennem `exec` værktøj og holder langvarige opgaver i hukommelsen. Værktøjet `process` styrer disse baggrundssessioner.

## exec-værktøj

Nøgleparametre:

- `command` (påkrævet)
- `yieldMs` (standard 10000): auto‑baggrund efter denne forsinkelse
- `background` (bool): kør straks i baggrunden
- `timeout` (sekunder, standard 1800): dræb processen efter denne timeout
- `elevated` (bool): kør på værten, hvis forhøjet tilstand er aktiveret/tilladt
- Har du brug for en rigtig TTY? Sæt `pty: true`.
- `workdir`, `env`

Adfærd:

- Forgrundskørsler returnerer output direkte.
- Når den køres i baggrunden (eksplicit eller via timeout), returnerer værktøjet `status: "running"` + `sessionId` samt en kort hale.
- Output gemmes i hukommelsen, indtil sessionen forespørges eller ryddes.
- Hvis værktøjet `process` ikke er tilladt, kører `exec` synkront og ignorerer `yieldMs`/`background`.

## Brokobling af underprocesser

Ved spawning af langvarige børneprocesser uden for eksekveren/procesværktøjer (f.eks. CLI respawns eller gateway-hjælpere) vedhæfte børneproces-bro-hjælperen, så opsigelsessignaler videresendes og lyttere frigøres på afslutning/fejl. Dette undgår forældreløse processer på systemd og holder shutdown adfærd konsekvent på tværs af platforme.

Miljøoverstyringer:

- `PI_BASH_YIELD_MS`: standard yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: outputloft i hukommelsen (tegn)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: loft for afventende stdout/stderr pr. stream (tegn)
- `PI_BASH_JOB_TTL_MS`: TTL for afsluttede sessioner (ms, begrænset til 1m–3h)

Konfiguration (foretrukket):

- `tools.exec.backgroundMs` (standard 10000)
- `tools.exec.timeoutSec` (standard 1800)
- `tools.exec.cleanupMs` (standard 1800000)
- `tools.exec.notifyOnExit` (standard true): sæt en systemhændelse i kø + anmod om heartbeat, når en baggrunds-exec afsluttes.

## process-værktøj

Handlinger:

- `list`: kørende + afsluttede sessioner
- `poll`: dræn nyt output for en session (rapporterer også exit-status)
- `log`: læs det aggregerede output (understøtter `offset` + `limit`)
- `write`: send stdin (`data`, valgfri `eof`)
- `kill`: afslut en baggrunds-session
- `clear`: fjern en afsluttet session fra hukommelsen
- `remove`: dræb hvis kørende, ellers ryd hvis afsluttet

Noter:

- Kun sessioner, der kører i baggrunden, listes/gemmes i hukommelsen.
- Sessioner går tabt ved procesgenstart (ingen diskpersistens).
- Sessionslogs gemmes kun i chathistorikken, hvis du kører `process poll/log`, og værktøjsresultatet registreres.
- `process` er afgrænset pr. agent; den kan kun se sessioner startet af den agent.
- `process list` inkluderer en afledt `name` (kommandoverbum + mål) til hurtige overblik.
- `process log` bruger linjebaseret `offset`/`limit` (udelad `offset` for at hente de sidste N linjer).

## Eksempler

Kør en lang opgave og forespørg senere:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Start straks i baggrunden:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
