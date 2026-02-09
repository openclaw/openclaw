---
summary: "Hvordan OpenClaw roterer auth-profiler og falder tilbage på tværs af modeller"
read_when:
  - Diagnosticering af rotation af auth-profiler, cooldowns eller model‑fallback‑adfærd
  - Opdatering af failover‑regler for auth-profiler eller modeller
title: "Model‑failover"
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
- `type: "oauth"` → `{ provider, adgang, opdatering, udløber e-mail? }` (+ `projectId`/`enterpriseUrl` for nogle udbydere)

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

OpenClaw **stifter den valgte auth profil per session** for at holde udbyder caches varm.
Det gør **ikke** rotere på hver anmodning. Den fastgjorte profil genbruges indtil:

- sessionen nulstilles (`/new` / `/reset`)
- en komprimering fuldføres (komprimeringstælleren øges)
- profilen er i cooldown/deaktiveret

Manuelt valg via `/model …@<profileId>` sætter en **bruger‑override** for den session
og auto‑roteres ikke, før en ny session starter.

Autofastgjorte profiler (udvalgt af sessionsrouteren) behandles som **præferencer**:
de prøves først men OpenClaw kan rotere til en anden profil på takstgrænser/timeouts.
Brugerfastgjorte profiler forbliver låst på denne profil; hvis det mislykkes, og model fallbacks
er konfigureret, OpenClaw flytter til den næste model i stedet for at skifte profiler.

### Hvorfor OAuth kan “se ud til at være væk”

Hvis du både har en OAuth profil og en API-nøgleprofil for den samme udbyder, kan rund-robin skifte mellem dem på tværs af meddelelser, medmindre de er fastgjort. For at tvinge en enkelt profil:

- Fastlås med `auth.order[provider] = ["provider:profileId"]`, eller
- Brug en pr.‑session‑override via `/model …` med en profil‑override (når understøttet af dit UI/chat‑miljø).

## Cooldowns

Hvis en profil fejler på grund af auth/rate-limit fejl (eller en tidsfrist, der ser ud til
som hastighedsbegrænsning) OpenClaw markerer det i nedkøling og flytter til den næste profil.
Format/ugyldig anmodning fejl (f.eks. Cloud Code Assist tool call ID
validering fejl) behandles som fejlværdig og bruger de samme nedkølinger.

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

## Fakturering deaktiverer

Fakturering/kreditfejl (for eksempel “utilstrækkelige kreditter” / “kreditsaldo for lavt”) behandles som failover-worthy, men de er normalt ikke forbigående. I stedet for en kort nedkøling markerer OpenClaw profilen som **deaktiveret** (med en længere tilbage-off) og roterer til den næste profil/udbyder.

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

Hvis alle profiler for en udbyder mislykkes, OpenClaw flytter til den næste model i
`agents.defaults.model.fallbacks`. Dette gælder for auth fiaskoer, hastighedsgrænser og
timeouts som udmattet profilrotation (andre fejl går ikke forud for tilbagefald).

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
