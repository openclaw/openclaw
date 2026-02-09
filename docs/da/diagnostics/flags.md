---
summary: "Diagnoseflag til målrettede debuglogs"
read_when:
  - Du har brug for målrettede debuglogs uden at hæve de globale logningsniveauer
  - Du har brug for at indsamle subsystem-specifikke logs til support
title: "Diagnoseflag"
---

# Diagnoseflag

Diagnostiske flag giver dig mulighed for at aktivere målrettede fejlfindingslogs uden at aktivere verbose logning overalt. Flag er opt-in og har ingen virkning, medmindre et delsystem kontrollerer dem.

## Sådan virker det

- Flag er strenge (ikke versalfølsomme).
- Du kan aktivere flag i konfigurationen eller via en env-override.
- Wildcards understøttes:
  - `telegram.*` matcher `telegram.http`
  - `*` aktiverer alle flag

## Aktivér via konfiguration

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Flere flag:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Genstart gatewayen efter ændring af flag.

## Env-override (engangsbrug)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Deaktivér alle flag:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Hvor logs havner

Flag udsender logfiler til standard diagnostik logfil. Som standard:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Hvis du har angivet `logging.file`, så brug stien i stedet. Logfiler er JSONL (et JSON objekt pr. linje). Redaction gælder stadig baseret på `logging.redactSensitive`.

## Udtræk logs

Vælg den seneste logfil:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrér for Telegram HTTP-diagnostik:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Eller følg loggen, mens du reproducerer:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

For fjern-gateways kan du også bruge `openclaw logs --follow` (se [/cli/logs](/cli/logs)).

## Noter

- Hvis `logging.level` er sat højere end `warn`, kan disse logs undertrykkes. Standard `info` er fint.
- Flag er sikre at lade være aktiveret; de påvirker kun logmængden for det specifikke subsystem.
- Brug [/logging](/logging) til at ændre logdestinationer, niveauer og redigering.
