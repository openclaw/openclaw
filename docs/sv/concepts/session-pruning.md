---
summary: "Sessionsrensning: trimning av verktygsresultat för att minska kontextuppblåsthet"
read_when:
  - Du vill minska LLM-kontekttillväxt från verktygsutdata
  - Du finjusterar agents.defaults.contextPruning
---

# Sessionsrensning

Sessionsbeskärning trims **gamla verktygsresultat** från minneskontexten precis innan varje LLM-anrop. Det skriver **inte** om sessionshistoriken på disken (`*.jsonl`).

## När den körs

- När `mode: "cache-ttl"` är aktiverat och det senaste Anthropic-anropet för sessionen är äldre än `ttl`.
- Påverkar endast de meddelanden som skickas till modellen för den begäran.
- Endast aktiv för Anthropic API-anrop (och OpenRouter Anthropic-modeller).
- För bästa resultat, matcha `ttl` till din modells `cacheControlTtl`.
- Efter en rensning återställs TTL-fönstret så att efterföljande begäranden behåller cache tills `ttl` löper ut igen.

## Smarta standardvärden (Anthropic)

- **OAuth- eller setup-token**-profiler: aktivera `cache-ttl`-rensning och ställ in heartbeat till `1h`.
- **API-nyckel**-profiler: aktivera `cache-ttl`-rensning, ställ in heartbeat till `30m`, och sätt standard `cacheControlTtl` till `1h` för Anthropic-modeller.
- Om du sätter något av dessa värden explicit åsidosätter OpenClaw dem **inte**.

## Vad detta förbättrar (kostnad + cachebeteende)

- **Varför beskära:** Antropisk prompt cachelagring gäller endast inom TTL. Om en session går vilse förbi TTL, nästa begäran cachelagrar den fullständiga frågan om du inte trimma den först.
- **Vad blir billigare:** rensning minskar **cacheWrite**-storleken för den första begäran efter att TTL har löpt ut.
- **Varför TTL-återställningen spelar roll:** när rensning körs återställs cachefönstret, så uppföljande begäranden kan återanvända den nyligen cachade prompten i stället för att cacha hela historiken igen.
- **Vad den inte gör:** rensning lägger inte till tokens eller ”dubblar” kostnader; den ändrar bara vad som cachas vid den första begäran efter TTL.

## Vad som kan rensas

- Endast `toolResult`-meddelanden.
- Användar- och assistentmeddelanden modifieras **aldrig**.
- De senaste `keepLastAssistants` assistentmeddelandena är skyddade; verktygsresultat efter den gränsen rensas inte.
- Om det inte finns tillräckligt många assistentmeddelanden för att fastställa gränsen hoppas rensning över.
- Verktygsresultat som innehåller **bildblock** hoppas över (trimmas/rensas aldrig).

## Uppskattning av kontextfönster

Beskärning använder ett uppskattat sammanhangsfönster (tecken <unk> tokens × 4). Basfönstret är löst i denna ordning:

1. `models.providers.*.models[].contextWindow`-åsidosättning.
2. Modelldefinitionens `contextWindow` (från modellregistret).
3. Standard `200000` tokens.

Om `agents.defaults.contextTokens` är satt behandlas det som ett tak (min) på det lösta fönstret.

## Läge

### cache-ttl

- Rensning körs endast om det senaste Anthropic-anropet är äldre än `ttl` (standard `5m`).
- När den körs: samma mjuk trimning + hård rensning som tidigare.

## Mjuk vs hård rensning

- **Mjuk trimning**: endast för överstora verktygsresultat.
  - Behåller början + slut, infogar `...` och lägger till en notering med ursprunglig storlek.
  - Hoppar över resultat med bildblock.
- **Hård rensning**: ersätter hela verktygsresultatet med `hardClear.placeholder`.

## Verktygsurval

- `tools.allow` / `tools.deny` stöder `*`-jokertecken.
- Nekande regler vinner.
- Matchning är skiftlägesokänslig.
- Tom tillåtelselista ⇒ alla verktyg tillåtna.

## Interaktion med andra begränsningar

- Inbyggda verktyg trunkerar redan sina egna utdata; sessionsrensning är ett extra lager som förhindrar att långvariga chattar ackumulerar för mycket verktygsutdata i modellkontexten.
- Komprimering är separat: komprimering sammanfattar och kvarstår, beskärning är övergående per begäran. Se [/concepts/compaction](/concepts/compaction).

## Standardvärden (när aktiverat)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Exempel

Standard (av):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Aktivera TTL-medveten rensning:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Begränsa rensning till specifika verktyg:

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

Se konfigreferens: [Gateway-konfiguration](/gateway/configuration)
