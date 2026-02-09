---
summary: "Hoe OpenClaw auth-profielen roteert en terugvalt over modellen"
read_when:
  - Het diagnosticeren van rotatie van auth-profielen, cooldowns of gedrag van model-fallback
  - Het bijwerken van failoverregels voor auth-profielen of modellen
title: "Model-failover"
---

# Model-failover

OpenClaw verwerkt fouten in twee fasen:

1. **Rotatie van auth-profielen** binnen de huidige provider.
2. **Model-fallback** naar het volgende model in `agents.defaults.model.fallbacks`.

Dit document legt de runtime-regels uit en de data die hieraan ten grondslag ligt.

## Auth-opslag (sleutels + OAuth)

OpenClaw gebruikt **auth-profielen** voor zowel API-sleutels als OAuth-tokens.

- Geheimen staan in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Config `auth.profiles` / `auth.order` zijn **alleen metadata + routing** (geen geheimen).
- Legacy OAuth-bestand alleen voor import: `~/.openclaw/credentials/oauth.json` (bij eerste gebruik geïmporteerd in `auth-profiles.json`).

Meer details: [/concepts/oauth](/concepts/oauth)

Inloggegevens types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` voor sommige providers)

## Profiel-ID’s

OAuth-aanmeldingen maken afzonderlijke profielen aan zodat meerdere accounts naast elkaar kunnen bestaan.

- Standaard: `provider:default` wanneer geen e-mailadres beschikbaar is.
- OAuth met e-mail: `provider:<email>` (bijvoorbeeld `google-antigravity:user@gmail.com`).

Profielen staan in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` onder `profiles`.

## Rotatievolgorde

Wanneer een provider meerdere profielen heeft, kiest OpenClaw een volgorde als volgt:

1. **Expliciete config**: `auth.order[provider]` (indien ingesteld).
2. **Geconfigureerde profielen**: `auth.profiles` gefilterd op provider.
3. **Opgeslagen profielen**: items in `auth-profiles.json` voor de provider.

Als er geen expliciete volgorde is geconfigureerd, gebruikt OpenClaw een round‑robinvolgorde:

- **Primaire sleutel:** profieltype (**OAuth vóór API-sleutels**).
- **Secundaire sleutel:** `usageStats.lastUsed` (oudste eerst, binnen elk type).
- **Cooldown/uitgeschakelde profielen** worden naar het einde verplaatst, geordend op eerstvolgende afloop.

### Sessiestickiness (cache-vriendelijk)

OpenClaw **pint het gekozen auth-profiel per sessie** om provider-caches warm te houden.
Het roteert **niet** bij elke request. Het gepinde profiel wordt hergebruikt totdat:

- de sessie wordt gereset (`/new` / `/reset`)
- een compactie is voltooid (compactieteller neemt toe)
- het profiel in cooldown staat of is uitgeschakeld

Handmatige selectie via `/model …@<profileId>` zet een **gebruikersoverride** voor die sessie
en wordt niet automatisch geroteerd totdat een nieuwe sessie start.

Automatisch gepinde profielen (geselecteerd door de sessierouter) worden behandeld als een **voorkeur**:
ze worden eerst geprobeerd, maar OpenClaw kan naar een ander profiel roteren bij rate limits/time-outs.
Door de gebruiker gepinde profielen blijven vast aan dat profiel; als dit faalt en model-fallbacks
zijn geconfigureerd, gaat OpenClaw naar het volgende model in plaats van profielen te wisselen.

### Waarom OAuth soms “verdwenen” kan lijken

Als je zowel een OAuth-profiel als een API-sleutelprofiel voor dezelfde provider hebt, kan round‑robin tussen berichten wisselen tenzij gepind. Om één profiel af te dwingen:

- Pin met `auth.order[provider] = ["provider:profileId"]`, of
- Gebruik een per-sessie override via `/model …` met een profieloverride (wanneer ondersteund door je UI/chatoppervlak).

## Cooldowns

Wanneer een profiel faalt door auth-/rate‑limitfouten (of een time-out die lijkt
op rate limiting), markeert OpenClaw het als in cooldown en gaat door naar het volgende profiel.
Formaat-/invalid‑requestfouten (bijvoorbeeld Cloud Code Assist tool call ID‑validatiefouten)
worden als failover‑waardig behandeld en gebruiken dezelfde cooldowns.

Cooldowns gebruiken exponentiële backoff:

- 1 minuut
- 5 minuten
- 25 minuten
- 1 uur (maximum)

Status wordt opgeslagen in `auth-profiles.json` onder `usageStats`:

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

## Billing-uitschakelingen

Billing-/creditfouten (bijvoorbeeld “onvoldoende credits” / “creditbalans te laag”) worden als failover‑waardig behandeld, maar zijn meestal niet tijdelijk. In plaats van een korte cooldown markeert OpenClaw het profiel als **uitgeschakeld** (met een langere backoff) en roteert naar het volgende profiel/provider.

Status wordt opgeslagen in `auth-profiles.json`:

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

Standaardwaarden:

- Billing-backoff start bij **5 uur**, verdubbelt per billingfout en heeft een maximum van **24 uur**.
- Backoff-tellers worden gereset als het profiel **24 uur** geen fout heeft gehad (configureerbaar).

## Model-fallback

Als alle profielen voor een provider falen, gaat OpenClaw naar het volgende model in
`agents.defaults.model.fallbacks`. Dit geldt voor auth-fouten, rate limits en
time-outs die de profielrotatie hebben uitgeput (andere fouten laten de fallback niet doorgaan).

Wanneer een run start met een modeloverride (hooks of CLI), eindigen fallbacks nog steeds bij
`agents.defaults.model.primary` na het proberen van eventuele geconfigureerde fallbacks.

## Gerelateerde config

Zie [Gateway-configuratie](/gateway/configuration) voor:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

Zie [Modellen](/concepts/models) voor het bredere overzicht van modelselectie en -fallback.
