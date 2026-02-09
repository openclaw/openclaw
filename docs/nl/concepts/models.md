---
summary: "Models CLI: lijst, instellen, aliassen, fallbacks, scannen, status"
read_when:
  - Modellen CLI toevoegen of wijzigen (models list/set/scan/aliases/fallbacks)
  - Gedrag van model-fallbacks of selectie-UX wijzigen
  - Model-scanprobes bijwerken (tools/afbeeldingen)
title: "Models CLI"
---

# Models CLI

Zie [/concepts/model-failover](/concepts/model-failover) voor auth-profielrotatie,
cooldowns en hoe dat samenwerkt met fallbacks.
Snelle provider-overzicht + voorbeelden: [/concepts/model-providers](/concepts/model-providers).

## Hoe modelselectie werkt

OpenClaw selecteert modellen in deze volgorde:

1. **Primair** model (`agents.defaults.model.primary` of `agents.defaults.model`).
2. **Fallbacks** in `agents.defaults.model.fallbacks` (op volgorde).
3. **Provider-auth failover** gebeurt binnen een provider voordat naar het
   volgende model wordt gegaan.

Gerelateerd:

- `agents.defaults.models` is de toegestane lijst/catalogus van modellen die OpenClaw kan gebruiken (plus aliassen).
- `agents.defaults.imageModel` wordt **alleen gebruikt wanneer** het primaire model geen afbeeldingen kan accepteren.
- Standaardinstellingen per agent kunnen `agents.defaults.model` overschrijven via `agents.list[].model` plus bindings (zie [/concepts/multi-agent](/concepts/multi-agent)).

## Snelle modelkeuzes (anekdotisch)

- **GLM**: iets beter voor coderen/tool-calling.
- **MiniMax**: beter voor schrijven en sfeer.

## Installatiewizard (aanbevolen)

Als je de config niet handmatig wilt bewerken, voer de onboarding-wizard uit:

```bash
openclaw onboard
```

Deze kan model + authenticatie instellen voor veelgebruikte providers, waaronder **OpenAI Code (Codex)
abonnement** (OAuth) en **Anthropic** (API-sleutel aanbevolen; `claude
setup-token` wordt ook ondersteund).

## Config-sleutels (overzicht)

- `agents.defaults.model.primary` en `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` en `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (toegestane lijst + aliassen + providerparameters)
- `models.providers` (aangepaste providers weggeschreven in `models.json`)

Modelreferenties worden genormaliseerd naar lowercase. Provider-aliassen zoals `z.ai/*` normaliseren
naar `zai/*`.

Voorbeelden van providerconfiguratie (inclusief OpenCode Zen) staan in
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Model is niet toegestaan” (en waarom antwoorden stoppen)

Als `agents.defaults.models` is ingesteld, wordt dit de **toegestane lijst** voor `/model` en voor
sessie-overschrijvingen. Wanneer een gebruiker een model selecteert dat niet in die toegestane lijst staat,
retourneert OpenClaw:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Dit gebeurt **vóór**dat een normaal antwoord wordt gegenereerd, waardoor het bericht kan aanvoelen
alsof het “niet reageerde”. De oplossing is om:

- Het model toe te voegen aan `agents.defaults.models`, of
- De toegestane lijst te wissen (verwijder `agents.defaults.models`), of
- Een model te kiezen uit `/model list`.

Voorbeeldconfiguratie voor een toegestane lijst:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Modellen wisselen in de chat (`/model`)

Je kunt modellen voor de huidige sessie wisselen zonder te herstarten:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notities:

- `/model` (en `/model list`) is een compacte, genummerde kiezer (modelfamilie + beschikbare providers).
- `/model <#>` selecteert vanuit die kiezer.
- `/model status` is de gedetailleerde weergave (auth-kandidaten en, indien geconfigureerd, provider-endpoint `baseUrl` + `api`-modus).
- Modelreferenties worden geparseerd door te splitsen op de **eerste** `/`. Gebruik `provider/model` bij het typen van `/model <ref>`.
- Als de model-ID zelf `/` bevat (OpenRouter-stijl), moet je de provider-prefix opnemen (voorbeeld: `/model openrouter/moonshotai/kimi-k2`).
- Als je de provider weglaat, behandelt OpenClaw de invoer als een alias of een model voor de **standaardprovider** (werkt alleen wanneer er geen `/` in de model-ID staat).

Volledig opdrachtgedrag/configuratie: [Slash commands](/tools/slash-commands).

## CLI-opdrachten

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (zonder subopdracht) is een snelkoppeling voor `models status`.

### `models list`

Toont standaard de geconfigureerde modellen. Handige flags:

- `--all`: volledige catalogus
- `--local`: alleen lokale providers
- `--provider <name>`: filter op provider
- `--plain`: één model per regel
- `--json`: machineleesbare uitvoer

### `models status`

Toont het opgeloste primaire model, fallbacks, afbeeldingsmodel en een auth-overzicht
van geconfigureerde providers. Het toont ook de OAuth-vervalstatus voor profielen die
in de auth-store zijn gevonden (waarschuwt standaard binnen 24 uur). `--plain` print alleen het
opgeloste primaire model.
OAuth-status wordt altijd getoond (en opgenomen in de `--json`-uitvoer). Als een geconfigureerde
provider geen referenties heeft, print `models status` een sectie **Missing auth**.
JSON bevat `auth.oauth` (waarschuwingsvenster + profielen) en `auth.providers`
(effectieve auth per provider).
Gebruik `--check` voor automatisering (exit `1` bij ontbrekend/verlopen, `2` bij bijna verlopen).

Voorkeursauth voor Anthropic is de Claude Code CLI setup-token (overal uit te voeren; plak op de Gateway-host indien nodig):

```bash
claude setup-token
openclaw models status
```

## Scannen (OpenRouter gratis modellen)

`openclaw models scan` inspecteert de **gratis modelcatalogus** van OpenRouter en kan
optioneel modellen testen op tool- en afbeeldingsondersteuning.

Belangrijke flags:

- `--no-probe`: sla live probes over (alleen metadata)
- `--min-params <b>`: minimale parametergrootte (miljarden)
- `--max-age-days <days>`: sla oudere modellen over
- `--provider <name>`: provider-prefixfilter
- `--max-candidates <n>`: grootte van de fallback-lijst
- `--set-default`: stel `agents.defaults.model.primary` in op de eerste selectie
- `--set-image`: stel `agents.defaults.imageModel.primary` in op de eerste afbeeldingsselectie

Probing vereist een OpenRouter API-sleutel (uit auth-profielen of
`OPENROUTER_API_KEY`). Zonder sleutel gebruik je `--no-probe` om alleen kandidaten te tonen.

Scanresultaten worden gerangschikt op:

1. Ondersteuning voor afbeeldingen
2. Tool-latentie
3. Contextgrootte
4. Aantal parameters

Invoer

- OpenRouter `/models`-lijst (filter `:free`)
- Vereist OpenRouter API-sleutel uit auth-profielen of `OPENROUTER_API_KEY` (zie [/environment](/help/environment))
- Optionele filters: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe-instellingen: `--timeout`, `--concurrency`

Wanneer uitgevoerd in een TTY, kun je fallbacks interactief selecteren. In niet-interactieve
modus geef je `--yes` mee om standaardwaarden te accepteren.

## Modellenregister (`models.json`)

Aangepaste providers in `models.providers` worden weggeschreven naar `models.json` onder de
agentdirectory (standaard `~/.openclaw/agents/<agentId>/models.json`). Dit bestand
wordt standaard samengevoegd, tenzij `models.mode` is ingesteld op `replace`.
