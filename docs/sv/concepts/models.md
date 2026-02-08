---
summary: "Models CLI: lista, ställ in, alias, fallbacks, skanna, status"
read_when:
  - Lägga till eller ändra models CLI (models list/set/scan/aliases/fallbacks)
  - Ändra beteende för modell-fallback eller UX för val
  - Uppdatera modellskanningsprober (verktyg/bilder)
title: "Models CLI"
x-i18n:
  source_path: concepts/models.md
  source_hash: 13e17a306245e0cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:05Z
---

# Models CLI

Se [/concepts/model-failover](/concepts/model-failover) för rotation av auth-profiler,
cooldowns och hur detta samverkar med fallbacks.
Snabb översikt över leverantörer + exempel: [/concepts/model-providers](/concepts/model-providers).

## Hur modellval fungerar

OpenClaw väljer modeller i denna ordning:

1. **Primär** modell (`agents.defaults.model.primary` eller `agents.defaults.model`).
2. **Fallbacks** i `agents.defaults.model.fallbacks` (i ordning).
3. **Provider auth failover** sker inom en leverantör innan man går vidare till
   nästa modell.

Relaterat:

- `agents.defaults.models` är tillåtelselistan/katalogen över modeller som OpenClaw kan använda (inklusive alias).
- `agents.defaults.imageModel` används **endast när** den primära modellen inte kan ta emot bilder.
- Standardvärden per agent kan åsidosätta `agents.defaults.model` via `agents.list[].model` samt bindningar (se [/concepts/multi-agent](/concepts/multi-agent)).

## Snabba modellval (anekdotiskt)

- **GLM**: lite bättre för kodning/verktygsanrop.
- **MiniMax**: bättre för skrivande och känsla.

## Setup‑guide (rekommenderas)

Om du inte vill redigera konfig manuellt, kör introduktionsguiden:

```bash
openclaw onboard
```

Den kan sätta upp modell + auth för vanliga leverantörer, inklusive **OpenAI Code (Codex)
prenumeration** (OAuth) och **Anthropic** (API‑nyckel rekommenderas; `claude
setup-token` stöds också).

## Konfig-nycklar (översikt)

- `agents.defaults.model.primary` och `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` och `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (tillåtelselista + alias + leverantörsparametrar)
- `models.providers` (anpassade leverantörer skrivs in i `models.json`)

Modellreferenser normaliseras till gemener. Leverantörsalias som `z.ai/*` normaliseras
till `zai/*`.

Exempel på leverantörskonfiguration (inklusive OpenCode Zen) finns i
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## ”Model is not allowed” (och varför svar upphör)

Om `agents.defaults.models` är satt blir den **tillåtelselistan** för `/model` och för
session‑åsidosättningar. När en användare väljer en modell som inte finns i den listan
returnerar OpenClaw:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Detta sker **innan** ett normalt svar genereras, så meddelandet kan kännas som att det
”inte svarade”. Åtgärden är att antingen:

- Lägga till modellen i `agents.defaults.models`, eller
- Rensa tillåtelselistan (ta bort `agents.defaults.models`), eller
- Välja en modell från `/model list`.

Exempel på tillåtelseliste‑konfig:

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

## Byta modeller i chatten (`/model`)

Du kan byta modell för den aktuella sessionen utan att starta om:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Noteringar:

- `/model` (och `/model list`) är en kompakt, numrerad väljare (modellfamilj + tillgängliga leverantörer).
- `/model <#>` väljer från den väljaren.
- `/model status` är den detaljerade vyn (auth‑kandidater och, när konfigurerat, leverantörens endpoint `baseUrl` + läge `api`).
- Modellreferenser parsas genom att dela på den **första** `/`. Använd `provider/model` när du skriver `/model <ref>`.
- Om modell‑ID:t i sig innehåller `/` (OpenRouter‑stil) måste du inkludera leverantörsprefixet (exempel: `/model openrouter/moonshotai/kimi-k2`).
- Om du utelämnar leverantören behandlar OpenClaw inmatningen som ett alias eller en modell för **standardleverantören** (fungerar endast när det inte finns något `/` i modell‑ID:t).

Fullständigt beteende/konfig för kommandon: [Slash commands](/tools/slash-commands).

## CLI‑kommandon

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

`openclaw models` (utan underkommando) är en genväg för `models status`.

### `models list`

Visar konfigurerade modeller som standard. Användbara flaggor:

- `--all`: full katalog
- `--local`: endast lokala leverantörer
- `--provider <name>`: filtrera efter leverantör
- `--plain`: en modell per rad
- `--json`: maskinläsbar utdata

### `models status`

Visar den upplösta primära modellen, fallbacks, bildmodell samt en auth‑översikt
över konfigurerade leverantörer. Den visar även OAuth‑utgångsstatus för profiler som hittas
i auth‑lagret (varnar inom 24 h som standard). `--plain` skriver endast ut den
upplösta primära modellen.
OAuth‑status visas alltid (och inkluderas i `--json`‑utdata). Om en konfigurerad
leverantör saknar autentiseringsuppgifter skriver `models status` ut en sektion **Missing auth**.
JSON inkluderar `auth.oauth` (varningsfönster + profiler) och `auth.providers`
(effektiv auth per leverantör).
Använd `--check` för automatisering (exit `1` vid saknad/utgången, `2` vid nära utgång).

Föredragen Anthropic‑auth är Claude Code CLI setup‑token (kör var som helst; klistra in på gateway‑värden vid behov):

```bash
claude setup-token
openclaw models status
```

## Skanning (OpenRouter gratis‑modeller)

`openclaw models scan` inspekterar OpenRouters **katalog över gratis modeller** och kan
valfritt proba modeller för stöd för verktyg och bilder.

Viktiga flaggor:

- `--no-probe`: hoppa över live‑prober (endast metadata)
- `--min-params <b>`: minsta parameterstorlek (miljarder)
- `--max-age-days <days>`: hoppa över äldre modeller
- `--provider <name>`: filter för leverantörsprefix
- `--max-candidates <n>`: storlek på fallback‑lista
- `--set-default`: sätt `agents.defaults.model.primary` till första valet
- `--set-image`: sätt `agents.defaults.imageModel.primary` till första bildvalet

Probing kräver en OpenRouter API‑nyckel (från auth‑profiler eller
`OPENROUTER_API_KEY`). Utan nyckel, använd `--no-probe` för att endast lista kandidater.

Skanningsresultat rangordnas efter:

1. Bildstöd
2. Verktygslatens
3. Kontextstorlek
4. Antal parametrar

Indata

- OpenRouter `/models`‑lista (filtrera `:free`)
- Kräver OpenRouter API‑nyckel från auth‑profiler eller `OPENROUTER_API_KEY` (se [/environment](/help/environment))
- Valfria filter: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probstyrning: `--timeout`, `--concurrency`

När den körs i en TTY kan du välja fallbacks interaktivt. I icke‑interaktivt
läge, skicka `--yes` för att acceptera standardvärden.

## Modellregister (`models.json`)

Anpassade leverantörer i `models.providers` skrivs in i `models.json` under
agentkatalogen (standard `~/.openclaw/agents/<agentId>/models.json`). Denna fil
slås samman som standard om inte `models.mode` är satt till `replace`.
