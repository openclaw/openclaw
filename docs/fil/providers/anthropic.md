---
summary: "Gamitin ang Anthropic Claude gamit ang mga API key o setup-token sa OpenClaw"
read_when:
  - Gusto mong gumamit ng mga Anthropic model sa OpenClaw
  - Gusto mo ng setup-token sa halip na mga API key
title: "Anthropic"
---

# Anthropic (Claude)

Binubuo ng Anthropic ang pamilya ng **Claude** na mga modelo at nagbibigay ng access sa pamamagitan ng isang API.
In OpenClaw you can authenticate with an API key or a **setup-token**.

## Opsyon A: Anthropic API key

**Pinakamainam para sa:** karaniwang API access at usage-based billing.
Lumikha ng iyong API key sa Anthropic Console.

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

Sinusuportahan ng OpenClaw ang tampok na prompt caching ng Anthropic. Ito ay **API-only**; ang subscription auth ay hindi nirerespeto ang mga cache setting.

### Konpigurasyon

Gamitin ang parameter na `cacheRetention` sa iyong model config:

| Value   | Cache Duration | Description                                                          |
| ------- | -------------- | -------------------------------------------------------------------- |
| `none`  | Walang caching | I-disable ang prompt caching                                         |
| `short` | 5 minuto       | Default para sa API Key auth                                         |
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

Kapag gumagamit ng Anthropic API Key authentication, awtomatikong inilalapat ng OpenClaw ang `cacheRetention: "short"` (5‑minutong cache) para sa lahat ng Anthropic model. Maaari mo itong i-override sa pamamagitan ng tahasang pagtatakda ng `cacheRetention` sa iyong config.

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

Ang mga setup-token ay nililikha ng **Claude Code CLI**, hindi ng Anthropic Console. Maaari mo itong patakbuhin sa **anumang makina**:

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
- Kung makita mo ang “OAuth token refresh failed …” sa isang Claude subscription, mag-re-auth gamit ang isang setup-token. Tingnan ang [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Ang mga detalye ng auth + mga patakaran sa reuse ay nasa [/concepts/oauth](/concepts/oauth).

## Pag-troubleshoot

**401 errors / biglang naging invalid ang token**

- Claude subscription auth can expire or be revoked. Re-run `claude setup-token`
  and paste it into the **gateway host**.
- Kung ang Claude CLI login ay nasa ibang machine, gamitin ang
  `openclaw models auth paste-token --provider anthropic` sa host ng Gateway.

**Walang nakitang API key para sa provider na "anthropic"**

- Auth is **per agent**. New agents don’t inherit the main agent’s keys.
- Patakbuhin muli ang onboarding para sa agent na iyon, o mag-paste ng setup-token / API key sa
  host ng Gateway, pagkatapos ay i-verify gamit ang `openclaw models status`.

**Walang nakitang credentials para sa profile na `anthropic:default`**

- Patakbuhin ang `openclaw models status` upang makita kung aling auth profile ang aktibo.
- Patakbuhin muli ang onboarding, o mag-paste ng setup-token / API key para sa profile na iyon.

**Walang available na auth profile (lahat ay nasa cooldown/hindi available)**

- Suriin ang `openclaw models status --json` para sa `auth.unusableProfiles`.
- Magdagdag ng isa pang Anthropic profile o maghintay na matapos ang cooldown.

Higit pa: [/gateway/troubleshooting](/gateway/troubleshooting) at [/help/faq](/help/faq).
