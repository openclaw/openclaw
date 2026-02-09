---
summary: "Diagnostische vlaggen voor gerichte debuglogs"
read_when:
  - Je hebt gerichte debuglogs nodig zonder het globale logniveau te verhogen
  - Je moet subsysteem-specifieke logs vastleggen voor ondersteuning
title: "Diagnostische vlaggen"
---

# Diagnostische vlaggen

Diagnostische vlaggen laten je gerichte debuglogs inschakelen zonder overal uitgebreide logging aan te zetten. Vlaggen zijn opt-in en hebben geen effect tenzij een subsysteem ze controleert.

## Hoe het werkt

- Vlaggen zijn strings (niet hoofdlettergevoelig).
- Je kunt vlaggen inschakelen in de config of via een env-override.
- Wildcards worden ondersteund:
  - `telegram.*` komt overeen met `telegram.http`
  - `*` schakelt alle vlaggen in

## Inschakelen via config

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Meerdere vlaggen:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Herstart de Gateway nadat je de vlaggen hebt gewijzigd.

## Env-override (eenmalig)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Alle vlaggen uitschakelen:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Waar logs terechtkomen

Vlaggen schrijven logs naar het standaard diagnostische logbestand. Standaard:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Als je `logging.file` instelt, wordt dat pad gebruikt. Logs zijn JSONL (één JSON-object per regel). Redactie blijft van toepassing op basis van `logging.redactSensitive`.

## Logs extraheren

Kies het meest recente logbestand:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filter op Telegram HTTP-diagnostiek:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Of volg live tijdens het reproduceren:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Voor externe Gateways kun je ook `openclaw logs --follow` gebruiken (zie [/cli/logs](/cli/logs)).

## Notities

- Als `logging.level` hoger is ingesteld dan `warn`, kunnen deze logs worden onderdrukt. De standaardwaarde `info` is prima.
- Vlaggen zijn veilig om ingeschakeld te laten; ze beïnvloeden alleen het logvolume voor het specifieke subsysteem.
- Gebruik [/logging](/logging) om logbestemmingen, niveaus en redactie te wijzigen.
