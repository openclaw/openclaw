---
summary: "CLI-reference for `openclaw models` (status/list/set/scan, aliaser, fallback-modeller, autentificering)"
read_when:
  - Du vil ændre standardmodeller eller se status for udbyderautentificering
  - Du vil scanne tilgængelige modeller/udbydere og fejlfinde autentificeringsprofiler
title: "modeller"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:04Z
---

# `openclaw models`

Model-discovery, scanning og konfiguration (standardmodel, fallback-modeller, autentificeringsprofiler).

Relateret:

- Udbydere + modeller: [Models](/providers/models)
- Opsætning af udbyderautentificering: [Getting started](/start/getting-started)

## Almindelige kommandoer

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` viser den løste standard/fallbacks samt et autentificerings-overblik.
Når snapshots for udbyderbrug er tilgængelige, indeholder afsnittet om OAuth/token-status
overskrifter for udbyderbrug.
Tilføj `--probe` for at køre live-autentificeringsprober mod hver konfigureret udbyderprofil.
Prober er reelle anmodninger (kan forbruge tokens og udløse rate limits).
Brug `--agent <id>` til at inspicere en konfigureret agents model-/autentificeringstilstand. Når den udelades,
bruger kommandoen `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` hvis angivet, ellers den
konfigurerede standardagent.

Noter:

- `models set <model-or-alias>` accepterer `provider/model` eller et alias.
- Modelreferencer parses ved at splitte på den **første** `/`. Hvis model-id’et indeholder `/` (OpenRouter-stil), skal du inkludere udbyderpræfikset (eksempel: `openrouter/moonshotai/kimi-k2`).
- Hvis du udelader udbyderen, behandler OpenClaw inputtet som et alias eller en model for **standardudbyderen** (virker kun når der ikke er `/` i model-id’et).

### `models status`

Indstillinger:

- `--json`
- `--plain`
- `--check` (exit 1=udløbet/mangler, 2=udløber)
- `--probe` (live-probe af konfigurerede autentificeringsprofiler)
- `--probe-provider <name>` (probe én udbyder)
- `--probe-profile <id>` (gentag eller kommaseparerede profil-id’er)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (konfigureret agent-id; tilsidesætter `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliaser + fallback-modeller

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Autentificeringsprofiler

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` kører en udbyderplugins autentificeringsflow (OAuth/API-nøgle). Brug
`openclaw plugins list` for at se, hvilke udbydere der er installeret.

Noter:

- `setup-token` beder om en setup-token-værdi (generér den med `claude setup-token` på en hvilken som helst maskine).
- `paste-token` accepterer en token-streng genereret andetsteds eller fra automatisering.
