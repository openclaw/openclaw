---
summary: "Bakgrundskörning av exec och processhantering"
read_when:
  - Lägga till eller ändra beteende för bakgrundsexekvering
  - Felsökning av långvariga exec-uppgifter
title: "Bakgrunds-Exec och Processverktyg"
x-i18n:
  source_path: gateway/background-process.md
  source_hash: e11a7d74a75000d6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:16Z
---

# Bakgrunds-Exec + Processverktyg

OpenClaw kör skalkommandon via verktyget `exec` och behåller långvariga uppgifter i minnet. Verktyget `process` hanterar dessa bakgrundssessioner.

## exec-verktyg

Viktiga parametrar:

- `command` (krävs)
- `yieldMs` (standard 10000): bakgrundslägg automatiskt efter denna fördröjning
- `background` (bool): kör i bakgrunden direkt
- `timeout` (sekunder, standard 1800): avsluta processen efter denna timeout
- `elevated` (bool): kör på värden om upphöjt läge är aktiverat/tillåtet
- Behöver du en riktig TTY? Sätt `pty: true`.
- `workdir`, `env`

Beteende:

- Körningar i förgrunden returnerar utdata direkt.
- När den körs i bakgrunden (explicit eller via timeout) returnerar verktyget `status: "running"` + `sessionId` samt en kort svans.
- Utdata hålls i minnet tills sessionen pollas eller rensas.
- Om verktyget `process` är otillåtet körs `exec` synkront och ignorerar `yieldMs`/`background`.

## Bryggning av barnprocesser

När långvariga barnprocesser startas utanför exec-/processverktygen (till exempel CLI-återstarter eller gateway-hjälpare), anslut hjälparen för bryggning av barnprocesser så att termineringssignaler vidarebefordras och lyssnare kopplas bort vid avslut/fel. Detta undviker föräldralösa processer på systemd och håller avstängningsbeteendet konsekvent över plattformar.

Miljöåsidosättningar:

- `PI_BASH_YIELD_MS`: standard-yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: gräns för utdata i minnet (tecken)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: gräns för väntande stdout/stderr per ström (tecken)
- `PI_BASH_JOB_TTL_MS`: TTL för avslutade sessioner (ms, begränsad till 1 m–3 h)

Konfig (föredras):

- `tools.exec.backgroundMs` (standard 10000)
- `tools.exec.timeoutSec` (standard 1800)
- `tools.exec.cleanupMs` (standard 1800000)
- `tools.exec.notifyOnExit` (standard true): köa en systemhändelse + begär hjärtslag när en bakgrundsexekvering avslutas.

## process-verktyg

Åtgärder:

- `list`: körande + avslutade sessioner
- `poll`: töm ny utdata för en session (rapporterar även avslutsstatus)
- `log`: läs den aggregerade utdatan (stöder `offset` + `limit`)
- `write`: skicka stdin (`data`, valfri `eof`)
- `kill`: terminera en bakgrundssession
- `clear`: ta bort en avslutad session från minnet
- `remove`: döda om den körs, annars rensa om den är avslutad

Noteringar:

- Endast bakgrundssessioner listas/persisteras i minnet.
- Sessioner går förlorade vid omstart av processen (ingen persistens på disk).
- Sessionsloggar sparas endast i chatthistoriken om du kör `process poll/log` och verktygsresultatet registreras.
- `process` är avgränsad per agent; den ser endast sessioner som startats av den agenten.
- `process list` inkluderar en härledd `name` (kommandoverb + mål) för snabba överblickar.
- `process log` använder radbaserad `offset`/`limit` (utelämna `offset` för att hämta de senaste N raderna).

## Exempel

Kör en lång uppgift och polla senare:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Starta omedelbart i bakgrunden:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Skicka stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
