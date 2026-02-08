---
summary: "Gamitin ang Anthropic Claude gamit ang mga API key o setup-token sa OpenClaw"
read_when:
  - Gusto mong gumamit ng mga Anthropic model sa OpenClaw
  - Gusto mo ng setup-token sa halip na mga API key
title: "Anthropic"
x-i18n:
  source_path: providers/anthropic.md
  source_hash: a0e91ae9fc5b67ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:48Z
---

# Anthropic (Claude)

Binubuo ng Anthropic ang pamilya ng **Claude** na mga model at nagbibigay ng access sa pamamagitan ng isang API.
Sa OpenClaw, maaari kang mag-authenticate gamit ang isang API key o isang **setup-token**.

## Opsyon A: Anthropic API key

**Pinakamainam para sa:** karaniwang API access at billing na batay sa paggamit.
Gumawa ng iyong API key sa Anthropic Console.

### CLI setup

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Snippet ng config

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt caching (Anthropic API)

Sinusuportahan ng OpenClaw ang feature ng prompt caching ng Anthropic. Ito ay **API-only**; hindi iginagalang ng subscription auth ang mga cache setting.

### Konpigurasyon

Gamitin ang parameter na `cacheRetention` sa iyong model config:

| Value   | Cache Duration | Description                                       |
| ------- | -------------- | ------------------------------------------------- |
| `none`  | Walang caching | I-disable ang prompt caching                      |
| `short` | 5 minuto       | Default para sa API Key auth                      |
| `long`  | 1 oras         | Pinalawig na cache (nangangailangan ng beta flag) |

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

### Mga default

Kapag gumagamit ng Anthropic API Key authentication, awtomatikong inilalapat ng OpenClaw ang `cacheRetention: "short"` (5-minutong cache) para sa lahat ng Anthropic model. Maaari mo itong i-override sa pamamagitan ng tahasang pag-set ng `cacheRetention` sa iyong config.

### Legacy na parameter

Ang mas lumang parameter na `cacheControlTtl` ay sinusuportahan pa rin para sa backwards compatibility:

- Ang `"5m"` ay nagma-map sa `short`
- Ang `"1h"` ay nagma-map sa `long`

Inirerekomenda naming mag-migrate sa bagong parameter na `cacheRetention`.

Kasama sa OpenClaw ang `extended-cache-ttl-2025-04-11` na beta flag para sa mga Anthropic API
request; panatilihin ito kung o-overtide mo ang mga provider header (tingnan ang [/gateway/configuration](/gateway/configuration)).

## Opsyon B: Claude setup-token

**Pinakamainam para sa:** paggamit ng iyong Claude subscription.

### Saan kukuha ng setup-token

Ang mga setup-token ay ginagawa ng **Claude Code CLI**, hindi ng Anthropic Console. Maaari mo itong patakbuhin sa **anumang machine**:

```bash
claude setup-token
```

I-paste ang token sa OpenClaw (wizard: **Anthropic token (i-paste ang setup-token)**), o patakbuhin ito sa host ng Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Kung ginawa mo ang token sa ibang machine, i-paste ito:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI setup (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Snippet ng config (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Mga tala

- I-generate ang setup-token gamit ang `claude setup-token` at i-paste ito, o patakbuhin ang `openclaw models auth setup-token` sa host ng Gateway.
- Kung makikita mo ang “OAuth token refresh failed …” sa isang Claude subscription, mag-re-auth gamit ang isang setup-token. Tingnan ang [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Ang mga detalye ng auth + mga patakaran sa reuse ay nasa [/concepts/oauth](/concepts/oauth).

## Pag-troubleshoot

**401 errors / biglang naging invalid ang token**

- Maaaring mag-expire o ma-revoke ang Claude subscription auth. Patakbuhin muli ang `claude setup-token`
  at i-paste ito sa **host ng Gateway**.
- Kung ang Claude CLI login ay nasa ibang machine, gamitin ang
  `openclaw models auth paste-token --provider anthropic` sa host ng Gateway.

**Walang nakitang API key para sa provider na "anthropic"**

- Ang auth ay **per agent**. Ang mga bagong agent ay hindi nagmamana ng mga key ng pangunahing agent.
- Patakbuhin muli ang onboarding para sa agent na iyon, o mag-paste ng setup-token / API key sa
  host ng Gateway, pagkatapos ay i-verify gamit ang `openclaw models status`.

**Walang nakitang credentials para sa profile na `anthropic:default`**

- Patakbuhin ang `openclaw models status` upang makita kung aling auth profile ang aktibo.
- Patakbuhin muli ang onboarding, o mag-paste ng setup-token / API key para sa profile na iyon.

**Walang available na auth profile (lahat ay nasa cooldown/hindi available)**

- Suriin ang `openclaw models status --json` para sa `auth.unusableProfiles`.
- Magdagdag ng isa pang Anthropic profile o maghintay na matapos ang cooldown.

Higit pa: [/gateway/troubleshooting](/gateway/troubleshooting) at [/help/faq](/help/faq).
