---
summary: "Hur OpenClaw roterar autentiseringsprofiler och faller tillbaka mellan modeller"
read_when:
  - Felsökning av rotation av autentiseringsprofiler, nedkylningsperioder eller beteende för modellfallback
  - Uppdatering av failover-regler för autentiseringsprofiler eller modeller
title: "Modellfailover"
---

# Modellfailover

OpenClaw hanterar fel i två steg:

1. **Rotation av autentiseringsprofiler** inom aktuell leverantör.
2. **Modellfallback** till nästa modell i `agents.defaults.model.fallbacks`.

Detta dokument förklarar körtidsreglerna och den data som stöder dem.

## Autentiseringslagring (nycklar + OAuth)

OpenClaw använder **autentiseringsprofiler** för både API-nycklar och OAuth-token.

- Hemligheter lagras i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Konfig `auth.profiles` / `auth.order` är **endast metadata + routning** (inga hemligheter).
- Legacy OAuth-fil endast för import: `~/.openclaw/credentials/oauth.json` (importeras till `auth-profiles.json` vid första användning).

Mer information: [/concepts/oauth](/concepts/oauth)

Autentiseringstyper:

- `type: "api_key"` → `{ provider, key }`
- `typ: "oauth"` → `{ leverantör, åtkomst, uppdatera, förfaller, e-post? }` (+ `projectId`/`enterpriseUrl` för vissa leverantörer)

## Profil-ID:n

OAuth-inloggningar skapar distinkta profiler så att flera konton kan samexistera.

- Standard: `provider:default` när ingen e-post är tillgänglig.
- OAuth med e-post: `provider:<email>` (till exempel `google-antigravity:user@gmail.com`).

Profiler finns i `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles`.

## Rotationsordning

När en leverantör har flera profiler väljer OpenClaw en ordning så här:

1. **Explicit konfig**: `auth.order[provider]` (om satt).
2. **Konfigurerade profiler**: `auth.profiles` filtrerade per leverantör.
3. **Lagrade profiler**: poster i `auth-profiles.json` för leverantören.

Om ingen explicit ordning är konfigurerad använder OpenClaw en round‑robin-ordning:

- **Primär nyckel:** profiltyp (**OAuth före API-nycklar**).
- **Sekundär nyckel:** `usageStats.lastUsed` (äldst först, inom varje typ).
- **Profiler i nedkylning/inaktiverade** flyttas till slutet, ordnade efter tidigast utgång.

### Sessionsklibbighet (cache-vänlig)

OpenClaw **sticker den valda auth profilen per session** för att hålla leverantörens cacher varma.
Det gör **inte** rotera på varje begäran. Den pinnade profilen återanvänds till:

- sessionen återställs (`/new` / `/reset`)
- en komprimering slutförs (komprimeringsräknaren ökar)
- profilen hamnar i nedkylning/inaktiveras

Manuellt val via `/model …@<profileId>` sätter en **användaråsidosättning** för den sessionen
och roteras inte automatiskt förrän en ny session startar.

Autopinnade profiler (valda av sessionsroutern) behandlas som en **preferens**:
de testas först, men OpenClaw kan rotera till en annan profil om hastighetsbegränsningar/tidsbegränsningar.
Användarprofilerna förblir låsta till den profilen; om det misslyckas och modellfallbackar
är konfigurerade, flyttar OpenClaw till nästa modell istället för att byta profiler.

### Varför OAuth kan ”se ut att försvinna”

Om du har både en OAuth-profil och en API-nyckelprofil för samma leverantör kan round‐robin växla mellan dem mellan meddelanden om de inte är fastsatta. Tvinga en enda profil:

- Lås med `auth.order[provider] = ["provider:profileId"]`, eller
- Använd en per-session-åsidosättning via `/model …` med en profilåsidosättning (när det stöds av ditt UI/chattgränssnitt).

## Nedkylning

När en profil misslyckas på grund av auth/rate‐limit fel (eller en timeout som ser ut som
som hastighetsbegränsning), OpenClaw markerar det i cooldown och flyttar till nästa profil.
Fel i format/invalid‐förfrågningar (till exempel Cloud Code Assist tool call ID
validation failures) behandlas som failover‐worthy och använder samma cooldowns.

Nedkylningar använder exponentiell backoff:

- 1 minut
- 5 minuter
- 25 minuter
- 1 timme (tak)

Tillstånd lagras i `auth-profiles.json` under `usageStats`:

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

## Inaktiveringar på grund av fakturering

Fakturering/kreditfel (till exempel “otillräckliga krediter” / “kreditbalans för låg”) behandlas som failover‐worthy, men de är oftast inte övergående. Istället för en kort nedkylning markerar OpenClaw profilen som **inaktiverad** (med längre bakåt) och roterar till nästa profil/leverantör.

Tillstånd lagras i `auth-profiles.json`:

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

Standardvärden:

- Backoff för fakturering startar på **5 timmar**, fördubblas per faktureringsfel och begränsas till **24 timmar**.
- Backoff-räknare återställs om profilen inte har misslyckats på **24 timmar** (konfigurerbart).

## Modellfallback

Om alla profiler för en leverantör misslyckas, flyttar OpenClaw till nästa modell i
`agents.defaults.model.fallbacks`. Detta gäller för auth fel, hastighetsgränser och
timeouts som utmattad profilrotation (andra fel inte förskott reserv).

När en körning startar med en modellåsidosättning (hooks eller CLI) slutar fallback ändå vid
`agents.defaults.model.primary` efter att ha provat eventuella konfigurerade fallbacks.

## Relaterad konfig

Se [Gateway-konfiguration](/gateway/configuration) för:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel`-routning

Se [Modeller](/concepts/models) för en bredare översikt över modellval och fallback.
