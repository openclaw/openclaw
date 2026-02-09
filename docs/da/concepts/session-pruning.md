---
summary: "Session pruning: trimning af værktøjsresultater for at reducere kontekstoppustning"
read_when:
  - Du vil reducere væksten i LLM-kontekst fra værktøjsoutput
  - Du finjusterer agents.defaults.contextPruning
---

# Session pruning

Session beskæresakse trimmer **gamle værktøj resultater** fra in-memory context lige før hvert LLM opkald. Det gør **ikke** omskrive on-disk sessionshistorikken (`*.jsonl`).

## Hvornår det kører

- Når `mode: "cache-ttl"` er aktiveret, og det sidste Anthropic-kald for sessionen er ældre end `ttl`.
- Påvirker kun de beskeder, der sendes til modellen for den anmodning.
- Kun aktivt for Anthropic API-kald (og OpenRouter Anthropic-modeller).
- For bedste resultater skal du matche `ttl` til din models `cacheControlTtl`.
- Efter en pruning nulstilles TTL-vinduet, så efterfølgende anmodninger beholder cache, indtil `ttl` udløber igen.

## Smarte standarder (Anthropic)

- **OAuth- eller setup-token**-profiler: aktivér `cache-ttl` pruning og sæt heartbeat til `1h`.
- **API-nøgle**-profiler: aktivér `cache-ttl` pruning, sæt heartbeat til `30m`, og sæt standard `cacheControlTtl` til `1h` på Anthropic-modeller.
- Hvis du sætter nogen af disse værdier eksplicit, tilsidesætter OpenClaw dem **ikke**.

## Hvad dette forbedrer (omkostning + cache-adfærd)

- **Hvorfor beskære:** Antropisk prompt caching gælder kun inden for TTL. Hvis en session går i tomgang forbi TTL, den næste anmodning re-caches den fulde prompt, medmindre du trimme den først.
- **Hvad bliver billigere:** pruning reducerer størrelsen af **cacheWrite** for den første anmodning efter TTL udløber.
- **Hvorfor TTL-nulstillingen betyder noget:** når pruning kører, nulstilles cache-vinduet, så efterfølgende anmodninger kan genbruge den friskcachende prompt i stedet for at gen-cache hele historikken igen.
- **Hvad det ikke gør:** pruning tilføjer ikke tokens eller “fordobler” omkostninger; det ændrer kun, hvad der caches ved den første post‑TTL-anmodning.

## Hvad kan prunes

- Kun `toolResult`-beskeder.
- Bruger- og assistentbeskeder modificeres **aldrig**.
- De sidste `keepLastAssistants` assistentbeskeder er beskyttet; værktøjsresultater efter den grænse prunes ikke.
- Hvis der ikke er nok assistentbeskeder til at fastlægge grænsen, springes pruning over.
- Værktøjsresultater, der indeholder **billedblokke**, springes over (trimmes/ryddes aldrig).

## Estimering af kontekstvindue

Beskæring bruger et anslået kontekstvindue (tegn ≈ tokens × 4). Grundvinduet er løst i denne rækkefølge:

1. `models.providers.*.models[].contextWindow`-override.
2. Modeldefinition `contextWindow` (fra modelregistret).
3. Standard `200000` tokens.

Hvis `agents.defaults.contextTokens` er sat, behandles den som et loft (min) på det fastlagte vindue.

## Tilstand

### cache-ttl

- Pruning kører kun, hvis det sidste Anthropic-kald er ældre end `ttl` (standard `5m`).
- Når det kører: samme soft-trim + hard-clear-adfærd som før.

## Soft vs hard pruning

- **Soft-trim**: kun for overdimensionerede værktøjsresultater.
  - Beholder head + tail, indsætter `...` og tilføjer en note med den oprindelige størrelse.
  - Springer resultater med billedblokke over.
- **Hard-clear**: erstatter hele værktøjsresultatet med `hardClear.placeholder`.

## Værktøjsudvælgelse

- `tools.allow` / `tools.deny` understøtter `*`-wildcards.
- Afvisning vinder.
- Matchning er ikke versalfølsom.
- Tom tilladelsesliste => alle værktøjer er tilladt.

## Samspil med andre grænser

- Indbyggede værktøjer afkorter allerede deres eget output; session pruning er et ekstra lag, der forhindrer, at langvarige chats akkumulerer for meget værktøjsoutput i modelkonteksten.
- Komprimering er separat: Komprimering opsummerer og fortsætter, beskæring er forbigående per anmodning. Se [/concepts/compaction](/concepts/compaction).

## Standarder (når aktiveret)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Eksempler

Standard (fra):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Aktivér TTL-bevidst pruning:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Begræns pruning til specifikke værktøjer:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Se konfigurationsreference: [Gateway Configuration](/gateway/configuration)
