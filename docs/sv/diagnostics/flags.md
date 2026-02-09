---
summary: "Diagnostikflaggor för riktade felsökningsloggar"
read_when:
  - Du behöver riktade felsökningsloggar utan att höja globala loggnivåer
  - Du behöver samla in undersystems­specifika loggar för support
title: "Diagnostikflaggor"
---

# Diagnostikflaggor

Diagnostikflaggor låter dig aktivera riktade debug loggar utan att slå på verbose loggning överallt. Flaggor är opt-in och har ingen effekt om inte ett delsystem kontrollerar dem.

## Hur det fungerar

- Flaggor är strängar (skiftlägesokänsliga).
- Du kan aktivera flaggor i konfig eller via en miljövariabel.
- Jokertecken stöds:
  - `telegram.*` matchar `telegram.http`
  - `*` aktiverar alla flaggor

## Aktivera via konfig

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Flera flaggor:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Starta om gateway (nätverksgateway) efter att du har ändrat flaggor.

## Miljövariabel (engångs)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Inaktivera alla flaggor:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Var loggar hamnar

Flaggor avger loggar in i standard diagnostik loggfil. Som standard:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Om du anger `logging.file`, använd den sökvägen istället. Loggar är JSONL (en JSON-objekt per rad). Redaction gäller fortfarande baserat på `logging.redactSensitive`.

## Extrahera loggar

Välj den senaste loggfilen:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtrera för Telegram HTTP-diagnostik:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Eller följ loggen medan du reproducerar:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

För fjärr-gateways kan du även använda `openclaw logs --follow` (se [/cli/logs](/cli/logs)).

## Noteringar

- Om `logging.level` är satt högre än `warn`, kan dessa loggar undertryckas. Standard `info` är bra.
- Flaggor är säkra att lämna aktiverade; de påverkar endast loggvolymen för det specifika undersystemet.
- Använd [/logging](/logging) för att ändra loggdestinationer, nivåer och maskning.
