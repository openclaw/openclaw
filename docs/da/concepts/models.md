---
summary: "Models CLI: list, set, aliaser, fallbacks, scan, status"
read_when:
  - Tilføjelse eller ændring af models CLI (models list/set/scan/aliases/fallbacks)
  - Ændring af model-fallback-adfærd eller valg-UX
  - Opdatering af model-scan-prober (værktøjer/billeder)
title: "Models CLI"
---

# Models CLI

Se [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, og hvordan det interagerer med fallbacks.
Hurtigtjenesteoversigt + eksempler: [/concepts/model-providers](/concepts/model-providers).

## Sådan fungerer modelvalg

OpenClaw vælger modeller i denne rækkefølge:

1. **Primær** model (`agents.defaults.model.primary` eller `agents.defaults.model`).
2. **Fallbacks** i `agents.defaults.model.fallbacks` (i rækkefølge).
3. **Udbyder-auth failover** sker inden for en udbyder, før der skiftes til den
   næste model.

Relateret:

- `agents.defaults.models` er tilladelseslisten/kataloget over modeller, som OpenClaw kan bruge (inkl. aliaser).
- `agents.defaults.imageModel` bruges **kun når** den primære model ikke kan acceptere billeder.
- Standarder pr. agent kan tilsidesætte `agents.defaults.model` via `agents.list[].model` plus bindings (se [/concepts/multi-agent](/concepts/multi-agent)).

## Hurtige modelvalg (anekdotisk)

- **GLM**: lidt bedre til kodning/værktøjskald.
- **MiniMax**: bedre til skrivning og stemning.

## Opsætningsguide (anbefalet)

Hvis du ikke vil håndredigere konfiguration, så kør introduktionsguiden:

```bash
openclaw onboard
```

Det kan oprette model + auth for almindelige udbydere, herunder **OpenAI Code (Codex)
abonnement** (OAuth) og **Anthropic** (API-nøgle anbefales; `claude
setup-token` understøttes også).

## Konfigurationsnøgler (overblik)

- `agents.defaults.model.primary` og `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` og `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (tilladelsesliste + aliaser + udbyderparametre)
- `models.providers` (brugerdefinerede udbydere skrevet ind i `models.json`)

Model refs er normaliseret til små bogstaver. Udbyder aliaser som `z.ai/*` normalisere
til `zai/*`.

Eksempler på udbyderkonfiguration (inkl. OpenCode Zen) findes i
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Model er ikke tilladt” (og hvorfor svar stopper)

Hvis `agents.defaults.models` er indstillet, bliver det **tilladt** for `/model` og for
session overrides. Når en bruger vælger en model, der ikke er i den tilladte liste,
OpenClaw returnerer:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Dette sker **før** et normalt svar er genereret, så beskeden kan føle
som om det “svarede ikke.” Rettelsen er til enten:

- Tilføje modellen til `agents.defaults.models`, eller
- Rydde tilladelseslisten (fjern `agents.defaults.models`), eller
- Vælge en model fra `/model list`.

Eksempel på tilladelsesliste-konfiguration:

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

## Skift af modeller i chat (`/model`)

Du kan skifte modeller for den aktuelle session uden at genstarte:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Noter:

- `/model` (og `/model list`) er en kompakt, nummereret vælger (modelfamilie + tilgængelige udbydere).
- `/model <#>` vælger fra den vælger.
- `/model status` er den detaljerede visning (auth-kandidater og, når konfigureret, udbyder-endpoint `baseUrl` + `api`-tilstand).
- Model refs parses ved at opdele på **først** `/`. Brug `provider/model` ved indtastning `/model <ref>`.
- Hvis selve model-ID’et indeholder `/` (OpenRouter-stil), skal du inkludere udbyder-præfikset (eksempel: `/model openrouter/moonshotai/kimi-k2`).
- Hvis du udelader udbyderen, behandler OpenClaw inputtet som et alias eller en model for **standardudbyderen** (virker kun, når der ikke er `/` i model-ID’et).

Fuld kommandoadfærd/konfiguration: [Slash commands](/tools/slash-commands).

## CLI-kommandoer

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

`openclaw models` (uden underkommando) er en genvej til `models status`.

### `models list`

Viser konfigurerede modeller som standard. Nyttige flag:

- `--all`: fuldt katalog
- `--local`: kun lokale udbydere
- `--provider <name>`: filtrér efter udbyder
- `--plain`: én model pr. linje
- `--json`: maskinlæsbar output

### `models status`

Viser den løste primære model, fallbacks, billedmodel og en auth oversigt
af konfigurerede udbydere. Det er også overflader OAuth udløbsstatus for profiler fundet
i auth store (advarer inden for 24 timer som standard). `--plain` udskrifter kun den
løste primære model.
OAuth status vises altid (og inkluderet i `--json` output). Hvis en konfigureret
udbyder ikke har nogen legitimationsoplysninger, udskriver `modelstatus` en \*\* Manglende auth\*\* sektion.
JSON indeholder `auth.oauth` (advar vindue + profiler) og `auth.providers`
(effektiv auth per provider).
Brug `--check` til automatisering (exit `1` når det mangler/er udløbet, `2` når det udløb).

Foretrukken Anthropic-auth er Claude Code CLI setup-token (kør hvor som helst; indsæt på gateway-værten om nødvendigt):

```bash
claude setup-token
openclaw models status
```

## Scanning (OpenRouter gratis modeller)

`openclaw models scan` inspicerer OpenRouters **gratis modelkatalog** og kan
valgfrit prober modeller for værktøjs- og billedunderstøttelse.

Vigtige flag:

- `--no-probe`: spring live-prober over (kun metadata)
- `--min-params <b>`: minimum parameterstørrelse (milliarder)
- `--max-age-days <days>`: spring ældre modeller over
- `--provider <name>`: udbyder-præfiksfilter
- `--max-candidates <n>`: størrelse på fallback-liste
- `--set-default`: sæt `agents.defaults.model.primary` til det første valg
- `--set-image`: sæt `agents.defaults.imageModel.primary` til det første billedvalg

Probing kræver en OpenRouter API-nøgle (fra godkendelsesprofiler eller
`OPENROUTER_API_KEY`). Uden en nøgle, brug `--no-probe` at liste kandidater kun.

Scanresultater rangeres efter:

1. Billedunderstøttelse
2. Værktøjs-latens
3. Kontekststørrelse
4. Antal parametre

Input

- OpenRouter `/models`-liste (filter `:free`)
- Kræver OpenRouter API-nøgle fra auth-profiler eller `OPENROUTER_API_KEY` (se [/environment](/help/environment))
- Valgfrie filtre: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe-kontroller: `--timeout`, `--concurrency`

Når du kører i en TTY, kan du vælge fallbacks interaktivt. I ikke-interaktiv
tilstand, pass `--yes` til at acceptere misligholdelser.

## Models registry (`models.json`)

Brugerdefinerede udbydere i `models.providers` er skrevet ind i `models.json` under
agent bibliotek (standard `~/.openclaw/agents/<agentId>/models.json`). Denne fil
er som standard flettet med mindre `models.mode` er sat til `erstatt`.
