---
summary: "Gebruik Anthropic Claude via API-sleutels of setup-token in OpenClaw"
read_when:
  - Je wilt Anthropic-modellen gebruiken in OpenClaw
  - Je wilt een setup-token gebruiken in plaats van API-sleutels
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic bouwt de **Claude**-modelfamilie en biedt toegang via een API.
In OpenClaw kun je authenticeren met een API-sleutel of een **setup-token**.

## Optie A: Anthropic API-sleutel

**Beste voor:** standaard API-toegang en gebruiksgebaseerde facturering.
Maak je API-sleutel aan in de Anthropic Console.

### CLI-installatie

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Config-fragment

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

OpenClaw ondersteunt de prompt-cachingfunctie van Anthropic. Dit is **alleen API**; abonnementsauthenticatie respecteert cache-instellingen niet.

### Configuratie

Gebruik de parameter `cacheRetention` in je modelconfig:

| Waarde  | Cacheduur    | Beschrijving                                             |
| ------- | ------------ | -------------------------------------------------------- |
| `none`  | Geen caching | Prompt caching uitschakelen                              |
| `short` | 5 minuten    | Standaard voor API-sleutelauth                           |
| `long`  | 1 uur        | Uitgebreide cache (vereist beta-flag) |

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

### Standaardwaarden

Bij gebruik van Anthropic API-sleutelauthenticatie past OpenClaw automatisch `cacheRetention: "short"` (cache van 5 minuten) toe voor alle Anthropic-modellen. Je kunt dit overschrijven door `cacheRetention` expliciet in je config in te stellen.

### Verouderde parameter

De oudere parameter `cacheControlTtl` wordt nog steeds ondersteund voor achterwaartse compatibiliteit:

- `"5m"` komt overeen met `short`
- `"1h"` komt overeen met `long`

We raden aan te migreren naar de nieuwe parameter `cacheRetention`.

OpenClaw bevat de beta-flag `extended-cache-ttl-2025-04-11` voor Anthropic API-aanvragen;
behoud deze als je provider-headers overschrijft (zie [/gateway/configuration](/gateway/configuration)).

## Optie B: Claude setup-token

**Beste voor:** het gebruiken van je Claude-abonnement.

### Waar je een setup-token krijgt

Setup-tokens worden aangemaakt door de **Claude Code CLI**, niet door de Anthropic Console. Je kunt dit op **elke machine** uitvoeren:

```bash
claude setup-token
```

Plak de token in OpenClaw (wizard: **Anthropic token (setup-token plakken)**), of voer het uit op de Gateway-host:

```bash
openclaw models auth setup-token --provider anthropic
```

Als je de token op een andere machine hebt gegenereerd, plak deze:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI-installatie (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Config-fragment (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notities

- Genereer de setup-token met `claude setup-token` en plak deze, of voer `openclaw models auth setup-token` uit op de Gateway-host.
- Als je “OAuth token refresh failed …” ziet bij een Claude-abonnement, authenticeer opnieuw met een setup-token. Zie [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Auth-details + hergebruikregels staan in [/concepts/oauth](/concepts/oauth).

## Problemen oplossen

**401-fouten / token plotseling ongeldig**

- Claude-abonnementsauth kan verlopen of worden ingetrokken. Voer `claude setup-token` opnieuw uit
  en plak deze op de **Gateway-host**.
- Als de Claude CLI-login op een andere machine staat, gebruik
  `openclaw models auth paste-token --provider anthropic` op de Gateway-host.

**Geen API-sleutel gevonden voor provider "anthropic"**

- Auth is **per agent**. Nieuwe agents erven de sleutels van de hoofdagent niet.
- Doorloop de onboarding opnieuw voor die agent, of plak een setup-token / API-sleutel op de
  Gateway-host en verifieer met `openclaw models status`.

**Geen inloggegevens gevonden voor profiel `anthropic:default`**

- Voer `openclaw models status` uit om te zien welk auth-profiel actief is.
- Doorloop de onboarding opnieuw, of plak een setup-token / API-sleutel voor dat profiel.

**Geen beschikbaar auth-profiel (alle in cooldown/onbeschikbaar)**

- Controleer `openclaw models status --json` op `auth.unusableProfiles`.
- Voeg een ander Anthropic-profiel toe of wacht tot de cooldown voorbij is.

Meer: [/gateway/troubleshooting](/gateway/troubleshooting) en [/help/faq](/help/faq).
