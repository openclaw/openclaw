---
summary: "Models CLI: listahan, set, mga alias, mga fallback, scan, status"
read_when:
  - Pagdaragdag o pagbabago sa models CLI (models list/set/scan/aliases/fallbacks)
  - Pagbabago sa behavior ng model fallback o UX ng pagpili
  - Pag-update ng mga probe ng model scan (tools/images)
title: "Models CLI"
x-i18n:
  source_path: concepts/models.md
  source_hash: 13e17a306245e0cc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:34Z
---

# Models CLI

Tingnan ang [/concepts/model-failover](/concepts/model-failover) para sa auth profile
rotation, mga cooldown, at kung paano ito nakikipag-ugnayan sa mga fallback.
Mabilis na pangkalahatang-ideya ng provider + mga halimbawa: [/concepts/model-providers](/concepts/model-providers).

## Paano gumagana ang pagpili ng model

Pinipili ng OpenClaw ang mga model sa ganitong pagkakasunod-sunod:

1. **Primary** na model (`agents.defaults.model.primary` o `agents.defaults.model`).
2. **Fallbacks** sa `agents.defaults.model.fallbacks` (ayon sa pagkakasunod).
3. **Provider auth failover** ay nangyayari sa loob ng isang provider bago lumipat sa
   susunod na model.

Kaugnay:

- Ang `agents.defaults.models` ay ang allowlist/catalog ng mga model na puwedeng gamitin ng OpenClaw (kasama ang mga alias).
- Ginagamit ang `agents.defaults.imageModel` **lamang kapag** hindi tumatanggap ng images ang primary model.
- Maaaring i-override ng mga default per-agent ang `agents.defaults.model` sa pamamagitan ng `agents.list[].model` kasama ang bindings (tingnan ang [/concepts/multi-agent](/concepts/multi-agent)).

## Mabilisang pagpili ng model (anekdotal)

- **GLM**: medyo mas magaling para sa coding/tool calling.
- **MiniMax**: mas mahusay para sa pagsusulat at vibes.

## Setup wizard (inirerekomenda)

Kung ayaw mong mano-manong i-edit ang config, patakbuhin ang onboarding wizard:

```bash
openclaw onboard
```

Maaari nitong i-setup ang model + auth para sa mga karaniwang provider, kabilang ang **OpenAI Code (Codex)
subscription** (OAuth) at **Anthropic** (inirerekomenda ang API key; suportado rin ang `claude
setup-token`).

## Mga config key (pangkalahatang-ideya)

- `agents.defaults.model.primary` at `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` at `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + mga alias + mga parameter ng provider)
- `models.providers` (mga custom provider na isinusulat sa `models.json`)

Ang mga model ref ay ini-normalize sa lowercase. Ang mga alias ng provider tulad ng `z.ai/*` ay ini-normalize
sa `zai/*`.

Ang mga halimbawa ng konpigurasyon ng provider (kasama ang OpenCode Zen) ay nasa
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Hindi pinapayagan ang model” (at bakit humihinto ang mga reply)

Kapag naka-set ang `agents.defaults.models`, ito ang nagiging **allowlist** para sa `/model` at para sa
mga override ng session. Kapag pumili ang user ng model na wala sa allowlist na iyon,
ibinabalik ng OpenClaw ang:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Nangyayari ito **bago** makabuo ng normal na reply, kaya maaaring magmukhang
parang “hindi nag-respond.” Ang solusyon ay alinman sa:

- Idagdag ang model sa `agents.defaults.models`, o
- I-clear ang allowlist (alisin ang `agents.defaults.models`), o
- Pumili ng model mula sa `/model list`.

Halimbawang allowlist config:

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

## Pagpapalit ng model sa chat (`/model`)

Maaari kang magpalit ng model para sa kasalukuyang session nang hindi nire-restart:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Mga tala:

- Ang `/model` (at `/model list`) ay isang compact, numbered picker (model family + mga available na provider).
- Ang `/model <#>` ay pumipili mula sa picker na iyon.
- Ang `/model status` ay ang detalyadong view (mga auth candidate at, kapag naka-configure, provider endpoint `baseUrl` + `api` mode).
- Ang mga model ref ay pinu-parse sa pamamagitan ng paghahati sa **unang** `/`. Gamitin ang `provider/model` kapag nagta-type ng `/model <ref>`.
- Kung ang model ID mismo ay naglalaman ng `/` (OpenRouter-style), dapat mong isama ang provider prefix (halimbawa: `/model openrouter/moonshotai/kimi-k2`).
- Kung aalisin mo ang provider, ituturing ng OpenClaw ang input bilang isang alias o isang model para sa **default provider** (gumagana lamang kapag walang `/` sa model ID).

Buong behavior/config ng command: [Slash commands](/tools/slash-commands).

## Mga command ng CLI

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

Ang `openclaw models` (walang subcommand) ay isang shortcut para sa `models status`.

### `models list`

Ipinapakita ang mga naka-configure na model bilang default. Mga kapaki-pakinabang na flag:

- `--all`: buong catalog
- `--local`: mga lokal na provider lang
- `--provider <name>`: i-filter ayon sa provider
- `--plain`: isang model bawat linya
- `--json`: machine‑readable na output

### `models status`

Ipinapakita ang resolved primary model, mga fallback, image model, at isang auth overview
ng mga naka-configure na provider. Ipinapakita rin nito ang OAuth expiry status para sa mga profile na natagpuan
sa auth store (nagbababala sa loob ng 24h bilang default). Ang `--plain` ay nagpi-print lamang ng
resolved primary model.
Palaging ipinapakita ang OAuth status (at kasama sa `--json` output). Kung ang isang naka-configure na
provider ay walang credentials, ang `models status` ay nagpi-print ng seksyong **Missing auth**.
Kasama sa JSON ang `auth.oauth` (warn window + mga profile) at `auth.providers`
(epektibong auth bawat provider).
Gamitin ang `--check` para sa automation (exit `1` kapag missing/expired, `2` kapag mag-e-expire).

Ang preferred Anthropic auth ay ang Claude Code CLI setup-token (patakbuhin kahit saan; i-paste sa host ng Gateway kung kailangan):

```bash
claude setup-token
openclaw models status
```

## Scanning (OpenRouter free models)

Ang `openclaw models scan` ay iniinspeksyon ang **free model catalog** ng OpenRouter at maaaring
opsyonal na i-probe ang mga model para sa suporta sa tool at image.

Mga pangunahing flag:

- `--no-probe`: laktawan ang live probes (metadata lang)
- `--min-params <b>`: minimum na laki ng parameter (bilyon)
- `--max-age-days <days>`: laktawan ang mas matatandang model
- `--provider <name>`: filter ng provider prefix
- `--max-candidates <n>`: laki ng fallback list
- `--set-default`: itakda ang `agents.defaults.model.primary` sa unang selection
- `--set-image`: itakda ang `agents.defaults.imageModel.primary` sa unang image selection

Nangangailangan ang probing ng OpenRouter API key (mula sa mga auth profile o
`OPENROUTER_API_KEY`). Kung walang key, gamitin ang `--no-probe` para ilista lang ang mga candidate.

Ang mga resulta ng scan ay niraranggo ayon sa:

1. Suporta sa image
2. Latency ng tool
3. Laki ng context
4. Bilang ng parameter

Input

- OpenRouter `/models` list (i-filter ang `:free`)
- Nangangailangan ng OpenRouter API key mula sa mga auth profile o `OPENROUTER_API_KEY` (tingnan ang [/environment](/help/environment))
- Opsyonal na mga filter: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Mga kontrol sa probe: `--timeout`, `--concurrency`

Kapag pinatakbo sa isang TTY, maaari mong piliin ang mga fallback nang interactive. Sa non‑interactive
mode, ipasa ang `--yes` para tanggapin ang mga default.

## Models registry (`models.json`)

Ang mga custom provider sa `models.providers` ay isinusulat sa `models.json` sa ilalim ng
agent directory (default `~/.openclaw/agents/<agentId>/models.json`). Ang file na ito
ay mino-merge bilang default maliban kung ang `models.mode` ay naka-set sa `replace`.
