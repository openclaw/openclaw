---
summary: "Använd Anthropic Claude via API-nycklar eller setup-token i OpenClaw"
read_when:
  - Du vill använda Anthropic-modeller i OpenClaw
  - Du vill använda setup-token i stället för API-nycklar
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:10Z
---

# Anthropic (Claude)

Anthropic bygger modellfamiljen **Claude** och tillhandahåller åtkomst via ett API.
I OpenClaw kan du autentisera med en API-nyckel eller en **setup-token**.

## Alternativ A: Anthropic API-nyckel

**Bäst för:** standard-API-åtkomst och användningsbaserad debitering.
Skapa din API-nyckel i Anthropic Console.

### CLI-konfigurering

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Konfigutdrag

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt-caching (Anthropic API)

OpenClaw stöder Anthropics funktion för prompt-caching. Detta är **endast för API**; prenumerationsautentisering respekterar inte cache-inställningar.

### Konfiguration

Använd parametern `cacheRetention` i din modellkonfig:

| Värde   | Cache-varaktighet | Beskrivning                          |
| ------- | ----------------- | ------------------------------------ |
| `none`  | Ingen caching     | Inaktivera prompt-caching            |
| `short` | 5 minuter         | Standard för API-nyckelautentisering |
| `long`  | 1 timme           | Utökad cache (kräver beta-flagga)    |

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

### Standardvärden

När du använder Anthropic API-nyckelautentisering tillämpar OpenClaw automatiskt `cacheRetention: "short"` (5-minuters cache) för alla Anthropic-modeller. Du kan åsidosätta detta genom att uttryckligen ange `cacheRetention` i din konfig.

### Äldre parameter

Den äldre parametern `cacheControlTtl` stöds fortfarande för bakåtkompatibilitet:

- `"5m"` mappar till `short`
- `"1h"` mappar till `long`

Vi rekommenderar att du migrerar till den nya parametern `cacheRetention`.

OpenClaw inkluderar beta-flaggan `extended-cache-ttl-2025-04-11` för Anthropic API-förfrågningar; behåll den om du åsidosätter leverantörshuvuden (se [/gateway/configuration](/gateway/configuration)).

## Alternativ B: Claude setup-token

**Bäst för:** att använda din Claude-prenumeration.

### Var får man en setup-token

Setup-tokens skapas av **Claude Code CLI**, inte av Anthropic Console. Du kan köra detta på **vilken maskin som helst**:

```bash
claude setup-token
```

Klistra in token i OpenClaw (guide: **Anthropic token (klistra in setup-token)**), eller kör det på gateway-värden:

```bash
openclaw models auth setup-token --provider anthropic
```

Om du genererade token på en annan maskin, klistra in den:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI-konfigurering (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Konfigutdrag (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Noteringar

- Generera setup-token med `claude setup-token` och klistra in den, eller kör `openclaw models auth setup-token` på gateway-värden.
- Om du ser ”OAuth token refresh failed …” för en Claude-prenumeration, autentisera på nytt med en setup-token. Se [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Autentiseringsdetaljer + regler för återanvändning finns i [/concepts/oauth](/concepts/oauth).

## Felsökning

**401-fel / token plötsligt ogiltig**

- Autentisering för Claude-prenumeration kan löpa ut eller återkallas. Kör `claude setup-token` igen
  och klistra in den på **gateway-värden**.
- Om inloggningen för Claude CLI finns på en annan maskin, använd
  `openclaw models auth paste-token --provider anthropic` på gateway-värden.

**Ingen API-nyckel hittades för leverantören ”anthropic”**

- Autentisering är **per agent**. Nya agenter ärver inte huvudagentens nycklar.
- Kör introduktionen igen för den agenten, eller klistra in en setup-token / API-nyckel på
  gateway-värden och verifiera sedan med `openclaw models status`.

**Inga autentiseringsuppgifter hittades för profilen `anthropic:default`**

- Kör `openclaw models status` för att se vilken autentiseringsprofil som är aktiv.
- Kör introduktionen igen, eller klistra in en setup-token / API-nyckel för den profilen.

**Ingen tillgänglig autentiseringsprofil (alla i cooldown/otillgängliga)**

- Kontrollera `openclaw models status --json` för `auth.unusableProfiles`.
- Lägg till en annan Anthropic-profil eller vänta tills cooldownen är över.

Mer: [/gateway/troubleshooting](/gateway/troubleshooting) och [/help/faq](/help/faq).
