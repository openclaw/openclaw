---
summary: "Sessiesnoeien: het inkorten van toolresultaten om contextopblazing te verminderen"
read_when:
  - Je wilt de groei van LLM-context door tooluitvoer verminderen
  - Je stemt agents.defaults.contextPruning af
---

# Sessiesnoeien

Sessiesnoeien trimt **oude toolresultaten** uit de in‑memory context vlak vóór elke LLM‑aanroep. Het herschrijft **niet** de on‑disk sessiegeschiedenis (`*.jsonl`).

## Wanneer het wordt uitgevoerd

- Wanneer `mode: "cache-ttl"` is ingeschakeld en de laatste Anthropic‑aanroep voor de sessie ouder is dan `ttl`.
- Heeft alleen effect op de berichten die voor dat verzoek naar het model worden gestuurd.
- Alleen actief voor Anthropic API‑aanroepen (en OpenRouter Anthropic‑modellen).
- Voor het beste resultaat laat je `ttl` aansluiten op de `cacheControlTtl` van je model.
- Na een snoei wordt het TTL‑venster gereset, zodat volgende verzoeken de cache behouden totdat `ttl` opnieuw verloopt.

## Slimme standaardinstellingen (Anthropic)

- **OAuth‑ of setup-token**‑profielen: schakel `cache-ttl`‑snoeien in en stel de heartbeat in op `1h`.
- **API‑sleutel**‑profielen: schakel `cache-ttl`‑snoeien in, stel de heartbeat in op `30m`, en zet standaard `cacheControlTtl` op `1h` voor Anthropic‑modellen.
- Als je een van deze waarden expliciet instelt, overschrijft OpenClaw ze **niet**.

## Wat dit verbetert (kosten + cachegedrag)

- **Waarom snoeien:** Anthropic promptcaching geldt alleen binnen de TTL. Als een sessie langer dan de TTL inactief is, cachet het volgende verzoek de volledige prompt opnieuw, tenzij je die eerst inkort.
- **Wat goedkoper wordt:** snoeien verkleint de **cacheWrite**‑grootte voor dat eerste verzoek nadat de TTL is verlopen.
- **Waarom de TTL‑reset telt:** zodra snoeien is uitgevoerd, reset het cachevenster, zodat vervolgverzoeken de vers gecachte prompt kunnen hergebruiken in plaats van de volledige geschiedenis opnieuw te cachen.
- **Wat het niet doet:** snoeien voegt geen tokens toe en “verdubbelt” geen kosten; het verandert alleen wat er wordt gecachet bij dat eerste post‑TTL‑verzoek.

## Wat kan worden gesnoeid

- Alleen `toolResult`‑berichten.
- Gebruikers‑ en assistentberichten worden **nooit** aangepast.
- De laatste `keepLastAssistants` assistentberichten zijn beschermd; toolresultaten na die afkap worden niet gesnoeid.
- Als er onvoldoende assistentberichten zijn om de afkap te bepalen, wordt snoeien overgeslagen.
- Toolresultaten met **image blocks** worden overgeslagen (nooit ingekort/gewist).

## Schatting van het contextvenster

Snoeien gebruikt een geschatte contextgrootte (tekens ≈ tokens × 4). Het basisvenster wordt in deze volgorde bepaald:

1. `models.providers.*.models[].contextWindow`‑override.
2. Modeldefinitie `contextWindow` (uit het modelregister).
3. Standaard `200000` tokens.

Als `agents.defaults.contextTokens` is ingesteld, wordt dit behandeld als een bovengrens (min) op het bepaalde venster.

## Modus

### cache-ttl

- Snoeien wordt alleen uitgevoerd als de laatste Anthropic‑aanroep ouder is dan `ttl` (standaard `5m`).
- Wanneer het wordt uitgevoerd: hetzelfde soft‑trim + hard‑clear‑gedrag als voorheen.

## Soft vs hard snoeien

- **Soft‑trim**: alleen voor te grote toolresultaten.
  - Behoudt kop + staart, voegt `...` in en voegt een notitie toe met de oorspronkelijke grootte.
  - Slaat resultaten met image blocks over.
- **Hard‑clear**: vervangt het volledige toolresultaat door `hardClear.placeholder`.

## Toolselectie

- `tools.allow` / `tools.deny` ondersteunen `*`‑wildcards.
- Weigeren wint.
- Overeenkomen is hoofdletterongevoelig.
- Lege toegestane lijst => alle tools toegestaan.

## Interactie met andere limieten

- Ingebouwde tools korten hun eigen uitvoer al in; sessiesnoeien is een extra laag die voorkomt dat langdurige chats te veel tooluitvoer in de modelcontext ophopen.
- Compactie staat los hiervan: compactie vat samen en wordt persistent opgeslagen; snoeien is tijdelijk per verzoek. Zie [/concepts/compaction](/concepts/compaction).

## Standaardwaarden (wanneer ingeschakeld)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Voorbeelden

Standaard (uit):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

TTL‑bewust snoeien inschakelen:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Snoeien beperken tot specifieke tools:

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

Zie configreferentie: [Gateway Configuration](/gateway/configuration)
