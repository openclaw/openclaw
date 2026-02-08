---
summary: "Diagnoseflag til målrettede debuglogs"
read_when:
  - Du har brug for målrettede debuglogs uden at hæve de globale logningsniveauer
  - Du har brug for at indsamle subsystem-specifikke logs til support
title: "Diagnoseflag"
x-i18n:
  source_path: diagnostics/flags.md
  source_hash: daf0eca0e6bd1cbc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:09Z
---

# Diagnoseflag

Diagnoseflag lader dig aktivere målrettede debuglogs uden at slå udførlig logning til overalt. Flag er opt-in og har ingen effekt, medmindre et subsystem tjekker dem.

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

Flag skriver logs til den standardiserede diagnose-logfil. Som standard:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Hvis du sætter `logging.file`, bruges den sti i stedet. Logs er JSONL (ét JSON-objekt pr. linje). Redigering gælder stadig baseret på `logging.redactSensitive`.

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

- Hvis `logging.level` er sat højere end `warn`, kan disse logs blive undertrykt. Standardværdien `info` er fin.
- Flag er sikre at lade være aktiveret; de påvirker kun logmængden for det specifikke subsystem.
- Brug [/logging](/logging) til at ændre logdestinationer, niveauer og redigering.
