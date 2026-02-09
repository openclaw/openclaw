---
summary: "Paano nirorotate ng OpenClaw ang mga auth profile at nagba-back fallback sa mga model"
read_when:
  - Pag-diagnose ng auth profile rotation, mga cooldown, o gawi ng model fallback
  - Pag-update ng mga failover rule para sa mga auth profile o mga model
title: "Model Failover"
---

# Model failover

Pinangangasiwaan ng OpenClaw ang mga failure sa dalawang yugto:

1. **Auth profile rotation** sa loob ng kasalukuyang provider.
2. **Model fallback** sa susunod na model sa `agents.defaults.model.fallbacks`.

Ipinapaliwanag ng dokumentong ito ang mga runtime rule at ang data na sumusuporta sa mga ito.

## Auth storage (mga key + OAuth)

Gumagamit ang OpenClaw ng **auth profiles** para sa parehong API key at OAuth token.

- Ang mga secret ay nasa `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Ang config na `auth.profiles` / `auth.order` ay **metadata + routing lamang** (walang secret).
- Legacy import-only OAuth file: `~/.openclaw/credentials/oauth.json` (ini-import sa `auth-profiles.json` sa unang paggamit).

Mas detalyado: [/concepts/oauth](/concepts/oauth)

Mga uri ng credential:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email?` }`(+`projectId`/`enterpriseUrl\` para sa ilang provider)

## Profile ID

Lumilikha ang mga OAuth login ng magkakahiwalay na profile upang makapag-coexist ang maraming account.

- Default: `provider:default` kapag walang available na email.
- OAuth na may email: `provider:<email>` (halimbawa `google-antigravity:user@gmail.com`).

Ang mga profile ay nasa `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` sa ilalim ng `profiles`.

## Ayos ng rotation

Kapag may maraming profile ang isang provider, pumipili ang OpenClaw ng ayos tulad nito:

1. **Explicit config**: `auth.order[provider]` (kung naka-set).
2. **Configured profiles**: `auth.profiles` na na-filter ayon sa provider.
3. **Stored profiles**: mga entry sa `auth-profiles.json` para sa provider.

Kung walang naka-configure na explicit na ayos, gumagamit ang OpenClaw ng round‑robin na ayos:

- **Primary key:** uri ng profile (**OAuth bago ang API key**).
- **Secondary key:** `usageStats.lastUsed` (pinakaluma muna, sa loob ng bawat uri).
- **Mga profile na naka-cooldown/disabled** ay inililipat sa dulo, nakaayos ayon sa pinakamalapit na oras ng pag-expire.

### Session stickiness (cache-friendly)

Ini-pin ng OpenClaw ang **napiling auth profile kada session** upang panatilihing mainit ang mga provider cache.
Hindi ito **umiikot sa bawat request**. Ang naka-pin na profile ay muling ginagamit hanggang:

- ma-reset ang session (`/new` / `/reset`)
- makumpleto ang isang compaction (tumataas ang compaction count)
- ang profile ay mapasok sa cooldown/disabled

Ang manual na pagpili sa pamamagitan ng `/model …@<profileId>` ay nagse-set ng **user override** para sa session na iyon
at hindi awtomatikong nirorotate hanggang magsimula ang bagong session.

Ang mga auto‑pinned profile (pinili ng session router) ay itinuturing na isang **preference**:
una silang sinusubukan, ngunit maaaring mag-rotate ang OpenClaw sa ibang profile kapag may rate limit/timeout.
Ang mga user‑pinned profile ay nananatiling naka-lock sa profile na iyon; kung pumalya at may naka-configure na model fallback,
lilipat ang OpenClaw sa susunod na modelo sa halip na magpalit ng profile.

### Bakit maaaring “magmukhang nawawala” ang OAuth

Kung mayroon kang parehong OAuth profile at API key profile para sa iisang provider, maaaring magpalit ang round‑robin sa pagitan nila sa iba’t ibang mensahe maliban kung naka-pin. Para pilitin ang iisang profile:

- I-pin gamit ang `auth.order[provider] = ["provider:profileId"]`, o
- Gumamit ng per-session override sa pamamagitan ng `/model …` na may profile override (kapag suportado ng iyong UI/chat surface).

## Mga cooldown

Kapag pumalya ang isang profile dahil sa auth/rate‑limit errors (o timeout na mukhang rate limiting), minamarkahan ito ng OpenClaw bilang naka-cooldown at lilipat sa susunod na profile.
Ang mga format/invalid‑request error (halimbawa, mga failure sa pag-validate ng Cloud Code Assist tool call ID) ay itinuturing na karapat-dapat sa failover at gumagamit ng parehong cooldown.

Gumagamit ang mga cooldown ng exponential backoff:

- 1 minuto
- 5 minuto
- 25 minuto
- 1 oras (cap)

Ang state ay naka-store sa `auth-profiles.json` sa ilalim ng `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Mga billing disable

Ang mga failure sa billing/credit (halimbawa “insufficient credits” / “credit balance too low”) ay itinuturing na karapat-dapat sa failover, ngunit kadalasan ay hindi sila transient. Sa halip na maikling cooldown, minamarkahan ng OpenClaw ang profile bilang **disabled** (na may mas mahabang backoff) at umiikot sa susunod na profile/provider.

Ang state ay naka-store sa `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Mga default:

- Nagsisimula ang billing backoff sa **5 oras**, dumodoble sa bawat billing failure, at may cap na **24 oras**.
- Nire-reset ang mga backoff counter kung hindi pumalya ang profile sa loob ng **24 oras** (configurable).

## Model fallback

If all profiles for a provider fail, OpenClaw moves to the next model in
`agents.defaults.model.fallbacks`. Nalalapat ito sa mga auth failure, rate limit, at
mga timeout na nakaubos ng profile rotation (ang ibang error ay hindi nag-a-advance ng fallback).

Kapag nagsimula ang isang run na may model override (hooks o CLI), nagtatapos pa rin ang mga fallback sa
`agents.defaults.model.primary` matapos subukan ang anumang naka-configure na fallback.

## Kaugnay na config

Tingnan ang [Gateway configuration](/gateway/configuration) para sa:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

Tingnan ang [Models](/concepts/models) para sa mas malawak na pangkalahatang-ideya ng pagpili ng model at fallback.
