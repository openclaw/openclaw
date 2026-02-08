---
summary: "Hvordan OpenClaw roterer auth-profiler og falder tilbage på tværs af modeller"
read_when:
  - Diagnosticering af rotation af auth-profiler, cooldowns eller model‑fallback‑adfærd
  - Opdatering af failover‑regler for auth-profiler eller modeller
title: "Model‑failover"
x-i18n:
  source_path: concepts/model-failover.md
  source_hash: eab7c0633824d941
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:17Z
---

# Model‑failover

OpenClaw håndterer fejl i to trin:

1. **Rotation af auth-profiler** inden for den aktuelle udbyder.
2. **Model‑fallback** til den næste model i `agents.defaults.model.fallbacks`.

Dette dokument forklarer runtime‑reglerne og de data, der understøtter dem.

## Auth‑lagring (nøgler + OAuth)

OpenClaw bruger **auth-profiler** til både API‑nøgler og OAuth‑tokens.

- Hemmeligheder ligger i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Konfiguration `auth.profiles` / `auth.order` er **kun metadata + routing** (ingen hemmeligheder).
- Legacy import‑only OAuth‑fil: `~/.openclaw/credentials/oauth.json` (importeres til `auth-profiles.json` ved første brug).

Mere detaljer: [/concepts/oauth](/concepts/oauth)

Credential‑typer:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for nogle udbydere)

## Profil‑ID’er

OAuth‑logins opretter separate profiler, så flere konti kan sameksistere.

- Standard: `provider:default` når der ikke er en e‑mail tilgængelig.
- OAuth med e‑mail: `provider:<email>` (for eksempel `google-antigravity:user@gmail.com`).

Profiler findes i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles`.

## Rotationsrækkefølge

Når en udbyder har flere profiler, vælger OpenClaw en rækkefølge sådan her:

1. **Eksplicit konfiguration**: `auth.order[provider]` (hvis angivet).
2. **Konfigurerede profiler**: `auth.profiles` filtreret efter udbyder.
3. **Gemte profiler**: poster i `auth-profiles.json` for udbyderen.

Hvis der ikke er konfigureret en eksplicit rækkefølge, bruger OpenClaw en round‑robin‑rækkefølge:

- **Primær nøgle:** profiltyper (**OAuth før API‑nøgler**).
- **Sekundær nøgle:** `usageStats.lastUsed` (ældste først, inden for hver type).
- **Profiler i cooldown/deaktiverede profiler** flyttes til sidst, sorteret efter snarlig udløb.

### Session‑klæbrighed (cache‑venlig)

OpenClaw **fastlåser den valgte auth‑profil pr. session** for at holde udbyder‑caches varme.
Den **roterer ikke ved hver anmodning**. Den fastlåste profil genbruges, indtil:

- sessionen nulstilles (`/new` / `/reset`)
- en komprimering fuldføres (komprimeringstælleren øges)
- profilen er i cooldown/deaktiveret

Manuelt valg via `/model …@<profileId>` sætter en **bruger‑override** for den session
og auto‑roteres ikke, før en ny session starter.

Auto‑fastlåste profiler (valgt af sessions‑routeren) behandles som en **præference**:
de prøves først, men OpenClaw kan rotere til en anden profil ved rate limits/timeouts.
Bruger‑fastlåste profiler forbliver låst til den profil; hvis den fejler og model‑fallbacks
er konfigureret, går OpenClaw videre til den næste model i stedet for at skifte profiler.

### Hvorfor OAuth kan “se ud til at være væk”

Hvis du både har en OAuth‑profil og en API‑nøgle‑profil for den samme udbyder, kan round‑robin skifte mellem dem på tværs af beskeder, medmindre de er fastlåst. For at tvinge én profil:

- Fastlås med `auth.order[provider] = ["provider:profileId"]`, eller
- Brug en pr.‑session‑override via `/model …` med en profil‑override (når understøttet af dit UI/chat‑miljø).

## Cooldowns

Når en profil fejler på grund af auth-/rate‑limit‑fejl (eller en timeout, der ligner
rate limiting), markerer OpenClaw den i cooldown og går videre til den næste profil.
Format-/ugyldig‑anmodning‑fejl (for eksempel Cloud Code Assist tool‑call‑ID‑valideringsfejl)
behandles som failover‑værdige og bruger de samme cooldowns.

Cooldowns bruger eksponentiel backoff:

- 1 minut
- 5 minutter
- 25 minutter
- 1 time (maks.)

Tilstand gemmes i `auth-profiles.json` under `usageStats`:

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

## Deaktiveringer pga. fakturering

Fakturering-/kreditfejl (for eksempel “insufficient credits” / “credit balance too low”) behandles som failover‑værdige, men de er typisk ikke forbigående. I stedet for en kort cooldown markerer OpenClaw profilen som **deaktiveret** (med en længere backoff) og roterer til den næste profil/udbyder.

Tilstand gemmes i `auth-profiles.json`:

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

Standarder:

- Fakturerings‑backoff starter ved **5 timer**, fordobles pr. faktureringsfejl og har et loft på **24 timer**.
- Backoff‑tællere nulstilles, hvis profilen ikke har fejlet i **24 timer** (kan konfigureres).

## Model‑fallback

Hvis alle profiler for en udbyder fejler, går OpenClaw videre til den næste model i
`agents.defaults.model.fallbacks`. Dette gælder for auth‑fejl, rate limits og
timeouts, der har udtømt profil‑rotationen (andre fejl fremrykker ikke fallback).

Når et run starter med en model‑override (hooks eller CLI), ender fallbacks stadig ved
`agents.defaults.model.primary` efter at have prøvet eventuelle konfigurerede fallbacks.

## Relateret konfiguration

Se [Gateway‑konfiguration](/gateway/configuration) for:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

Se [Modeller](/concepts/models) for et bredere overblik over modelvalg og fallback.
