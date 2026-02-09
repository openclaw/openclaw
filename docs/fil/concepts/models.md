---
summary: "Models CLI: listahan, set, mga alias, mga fallback, scan, status"
read_when:
  - Pagdaragdag o pagbabago sa models CLI (models list/set/scan/aliases/fallbacks)
  - Pagbabago sa behavior ng model fallback o UX ng pagpili
  - Pag-update ng mga probe ng model scan (tools/images)
title: "Models CLI"
---

# Models CLI

See [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, and how that interacts with fallbacks.
Quick provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

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

Model refs are normalized to lowercase. Provider aliases like `z.ai/*` normalize
to `zai/*`.

Ang mga halimbawa ng konpigurasyon ng provider (kasama ang OpenCode Zen) ay nasa
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Hindi pinapayagan ang model” (at bakit humihinto ang mga reply)

If `agents.defaults.models` is set, it becomes the **allowlist** for `/model` and for
session overrides. When a user selects a model that isn’t in that allowlist,
OpenClaw returns:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” The fix is to either:

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
- Model refs are parsed by splitting on the **first** `/`. Use `provider/model` when typing `/model <ref>`.
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

Shows configured models by default. Useful flags:

- `--all`: buong catalog
- `--local`: mga lokal na provider lang
- `--provider <name>`: i-filter ayon sa provider
- `--plain`: isang model bawat linya
- `--json`: machine‑readable na output

### `models status`

Shows the resolved primary model, fallbacks, image model, and an auth overview
of configured providers. It also surfaces OAuth expiry status for profiles found
in the auth store (warns within 24h by default). `--plain` prints only the
resolved primary model.
OAuth status is always shown (and included in `--json` output). If a configured
provider has no credentials, `models status` prints a **Missing auth** section.
JSON includes `auth.oauth` (warn window + profiles) and `auth.providers`
(effective auth per provider).
Use `--check` for automation (exit `1` when missing/expired, `2` when expiring).

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

Probing requires an OpenRouter API key (from auth profiles or
`OPENROUTER_API_KEY`). Without a key, use `--no-probe` to list candidates only.

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

When run in a TTY, you can select fallbacks interactively. In non‑interactive
mode, pass `--yes` to accept defaults.

## Models registry (`models.json`)

Custom providers in `models.providers` are written into `models.json` under the
agent directory (default `~/.openclaw/agents/<agentId>/models.json`). This file
is merged by default unless `models.mode` is set to `replace`.
