---
summary: "CLI-referentie voor `openclaw models` (status/list/set/scan, aliassen, fallbacks, authenticatie)"
read_when:
  - Je wilt standaardmodellen wijzigen of de authenticatiestatus van providers bekijken
  - Je wilt beschikbare modellen/providers scannen en authenticatieprofielen debuggen
title: "modellen"
---

# `openclaw models`

Model discovery, scannen en configuratie (standaardmodel, fallbacks, authenticatieprofielen).

Gerelateerd:

- Providers + modellen: [Models](/providers/models)
- Provider-authenticatie instellen: [Aan de slag](/start/getting-started)

## Veelgebruikte opdrachten

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` toont de opgeloste standaard/fallbacks plus een authenticatie-overzicht.
Wanneer gebruikssnapshots van providers beschikbaar zijn, bevat de sectie OAuth/tokenstatus
provider-usage-headers.
Voeg `--probe` toe om live authenticatieprobes uit te voeren tegen elk geconfigureerd providerprofiel.
Probes zijn echte verzoeken (kunnen tokens verbruiken en rate limits activeren).
Gebruik `--agent <id>` om de model-/auth-status van een geconfigureerde agent te inspecteren. Wanneer weggelaten,
gebruikt de opdracht `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` indien ingesteld, anders de
geconfigureerde standaardagent.

Notities:

- `models set <model-or-alias>` accepteert `provider/model` of een alias.
- Modelreferenties worden geparseerd door te splitsen op de **eerste** `/`. Als de model-ID `/` bevat (OpenRouter-stijl), voeg dan de providerprefix toe (voorbeeld: `openrouter/moonshotai/kimi-k2`).
- Als je de provider weglaat, behandelt OpenClaw de invoer als een alias of een model voor de **standaardprovider** (werkt alleen wanneer er geen `/` in de model-ID zit).

### `models status`

Opties:

- `--json`
- `--plain`
- `--check` (exit 1=verlopen/ontbrekend, 2=bijna verlopen)
- `--probe` (live probe van geconfigureerde authenticatieprofielen)
- `--probe-provider <name>` (probe één provider)
- `--probe-profile <id>` (herhalen of door komma’s gescheiden profiel-id’s)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (geconfigureerde agent-id; overschrijft `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliassen + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Authenticatieprofielen

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` voert de authenticatiestroom (OAuth/API-sleutel) van een providerplugin uit. Gebruik
`openclaw plugins list` om te zien welke providers zijn geïnstalleerd.

Notities:

- `setup-token` vraagt om een setup-tokenwaarde (genereer deze met `claude setup-token` op elke machine).
- `paste-token` accepteert een tokenstring die elders of via automatisering is gegenereerd.
