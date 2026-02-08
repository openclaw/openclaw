---
summary: "Brug Anthropic Claude via API-nøgler eller setup-token i OpenClaw"
read_when:
  - Du vil bruge Anthropic-modeller i OpenClaw
  - Du vil bruge setup-token i stedet for API-nøgler
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:36Z
---

# Anthropic (Claude)

Anthropic udvikler **Claude**-modelfamilien og giver adgang via et API.
I OpenClaw kan du autentificere med en API-nøgle eller et **setup-token**.

## Valgmulighed A: Anthropic API-nøgle

**Bedst til:** standard API-adgang og forbrugsbaseret fakturering.
Opret din API-nøgle i Anthropic Console.

### CLI-opsætning

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Konfigurationsudsnit

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw understøtter Anthropics prompt caching-funktion. Dette er **kun API**; abonnementsautentificering respekterer ikke cache-indstillinger.

### Konfiguration

Brug parameteren `cacheRetention` i din modelkonfiguration:

| Værdi   | Cachevarighed | Beskrivelse                            |
| ------- | ------------- | -------------------------------------- |
| `none`  | Ingen caching | Deaktiver prompt caching               |
| `short` | 5 minutter    | Standard for API-nøgle-autentificering |
| `long`  | 1 time        | Udvidet cache (kræver beta-flag)       |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Standarder

Når du bruger Anthropic API-nøgle-autentificering, anvender OpenClaw automatisk `cacheRetention: "short"` (5-minutters cache) for alle Anthropic-modeller. Du kan tilsidesætte dette ved eksplicit at sætte `cacheRetention` i din konfiguration.

### Ældre parameter

Den ældre parameter `cacheControlTtl` understøttes stadig for bagudkompatibilitet:

- `"5m"` kortlægges til `short`
- `"1h"` kortlægges til `long`

Vi anbefaler at migrere til den nye parameter `cacheRetention`.

OpenClaw inkluderer `extended-cache-ttl-2025-04-11` beta-flaget for Anthropic API-forespørgsler; behold det, hvis du tilsidesætter udbyder-headers (se [/gateway/configuration](/gateway/configuration)).

## Valgmulighed B: Claude setup-token

**Bedst til:** brug af dit Claude-abonnement.

### Hvor får du et setup-token

Setup-tokens oprettes af **Claude Code CLI**, ikke Anthropic Console. Du kan køre dette på **enhver maskine**:

```bash
claude setup-token
```

Indsæt tokenet i OpenClaw (opsætningsguide: **Anthropic token (indsæt setup-token)**), eller kør det på gateway-værten:

```bash
openclaw models auth setup-token --provider anthropic
```

Hvis du genererede tokenet på en anden maskine, så indsæt det:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI-opsætning (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Konfigurationsudsnit (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Noter

- Generér setup-tokenet med `claude setup-token` og indsæt det, eller kør `openclaw models auth setup-token` på gateway-værten.
- Hvis du ser “OAuth token refresh failed …” på et Claude-abonnement, så genautentificér med et setup-token. Se [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Autentificeringsdetaljer + genbrugsregler findes i [/concepts/oauth](/concepts/oauth).

## Fejlfinding

**401-fejl / token pludselig ugyldigt**

- Claude-abonnementsautentificering kan udløbe eller blive tilbagekaldt. Kør `claude setup-token`
  og indsæt det på **gateway-værten**.
- Hvis Claude CLI-login findes på en anden maskine, så brug
  `openclaw models auth paste-token --provider anthropic` på gateway-værten.

**Ingen API-nøgle fundet for udbyderen "anthropic"**

- Autentificering er **per agent**. Nye agenter arver ikke hovedagentens nøgler.
- Kør introduktionen igen for den agent, eller indsæt et setup-token / en API-nøgle på
  gateway-værten, og verificér derefter med `openclaw models status`.

**Ingen legitimationsoplysninger fundet for profilen `anthropic:default`**

- Kør `openclaw models status` for at se, hvilken autentificeringsprofil der er aktiv.
- Kør introduktionen igen, eller indsæt et setup-token / en API-nøgle for den profil.

**Ingen tilgængelig autentificeringsprofil (alle i cooldown/utilgængelige)**

- Tjek `openclaw models status --json` for `auth.unusableProfiles`.
- Tilføj en anden Anthropic-profil eller vent på cooldown.

Mere: [/gateway/troubleshooting](/gateway/troubleshooting) og [/help/faq](/help/faq).
