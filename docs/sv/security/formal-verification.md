---
title: Formell verifiering (säkerhetsmodeller)
summary: Maskinkontrollerade säkerhetsmodeller för OpenClaws mest riskfyllda flöden.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:36Z
---

# Formell verifiering (säkerhetsmodeller)

Den här sidan spårar OpenClaws **formella säkerhetsmodeller** (TLA+/TLC i dag; fler vid behov).

> Obs: vissa äldre länkar kan hänvisa till det tidigare projektnamnet.

**Mål (ledstjärna):** tillhandahålla ett maskinkontrollerat argument för att OpenClaw upprätthåller sin
avsedda säkerhetspolicy (auktorisering, sessionsisolering, verktygsgating och
säkerhet vid felkonfiguration), under explicita antaganden.

**Vad detta är (i dag):** en körbar, angripardriven **säkerhetsregressionssvit**:

- Varje påstående har en körbar modellkontroll över ett ändligt tillståndsrum.
- Många påståenden har en parad **negativ modell** som producerar ett motexempelspår för en realistisk buggklass.

**Vad detta inte är (än):** ett bevis för att ”OpenClaw är säker i alla avseenden” eller att den fullständiga TypeScript-implementeringen är korrekt.

## Var modellerna finns

Modellerna underhålls i ett separat repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Viktiga förbehåll

- Detta är **modeller**, inte den fullständiga TypeScript-implementeringen. Avvikelser mellan modell och kod är möjliga.
- Resultaten är begränsade av tillståndsrummet som utforskas av TLC; ”grönt” innebär inte säkerhet bortom de modellerade antagandena och gränserna.
- Vissa påståenden förlitar sig på explicita miljöantaganden (t.ex. korrekt driftsättning, korrekta konfigurationsindata).

## Återskapa resultat

I dag återskapas resultaten genom att klona modell-repot lokalt och köra TLC (se nedan). En framtida iteration kan erbjuda:

- CI-körda modeller med publika artefakter (motexempelspår, körloggar)
- ett hostat ”kör den här modellen”-arbetsflöde för små, begränsade kontroller

Kom igång:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway-exponering och öppen gateway-felkonfiguration

**Påstående:** bindning bortom loopback utan autentisering kan möjliggöra fjärrkompromettering / ökar exponeringen; token/lösenord blockerar oauktoriserade angripare (enligt modellantagandena).

- Gröna körningar:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Röda (förväntade):
  - `make gateway-exposure-v2-negative`

Se även: `docs/gateway-exposure-matrix.md` i modell-repot.

### Nodes.run-pipeline (högsta riskkapacitet)

**Påstående:** `nodes.run` kräver (a) tillåtelselista för node-kommandon plus deklarerade kommandon och (b) livegodkännande när konfigurerat; godkännanden är tokeniserade för att förhindra replay (i modellen).

- Gröna körningar:
  - `make nodes-pipeline`
  - `make approvals-token`
- Röda (förväntade):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Paringslager (DM-gating)

**Påstående:** parningsförfrågningar respekterar TTL och tak för väntande förfrågningar.

- Gröna körningar:
  - `make pairing`
  - `make pairing-cap`
- Röda (förväntade):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress-gating (omnämnanden + kringgående av kontrollkommandon)

**Påstående:** i gruppkontexter som kräver omnämnande kan ett oauktoriserat ”kontrollkommando” inte kringgå omnämnandegating.

- Grön:
  - `make ingress-gating`
- Röd (förväntad):
  - `make ingress-gating-negative`

### Routing-/sessionsnyckelisolering

**Påstående:** DM:er från olika parter kollapsar inte till samma session om de inte uttryckligen länkas/konfigureras.

- Grön:
  - `make routing-isolation`
- Röd (förväntad):
  - `make routing-isolation-negative`

## v1++: ytterligare begränsade modeller (konkurrens, omförsök, spårkorrekthet)

Dessa är uppföljande modeller som skärper realism kring verkliga felmoder (icke-atomära uppdateringar, omförsök och meddelandefan-out).

### Paringslager: konkurrens / idempotens

**Påstående:** ett parningslager ska upprätthålla `MaxPending` och idempotens även under interleavings (d.v.s. ”check-then-write” måste vara atomär / låst; uppdatering ska inte skapa dubbletter).

Vad det innebär:

- Under samtidiga förfrågningar kan du inte överskrida `MaxPending` för en kanal.
- Upprepade förfrågningar/uppdateringar för samma `(channel, sender)` ska inte skapa dubbla aktiva väntande rader.

- Gröna körningar:
  - `make pairing-race` (atomär/låst kapacitetskontroll)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Röda (förväntade):
  - `make pairing-race-negative` (icke-atomär begin/commit-kapacitetsrace)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress: spårkorrelation / idempotens

**Påstående:** ingestering ska bevara spårkorrelation över fan-out och vara idempotent vid leverantörers omförsök.

Vad det innebär:

- När en extern händelse blir flera interna meddelanden behåller varje del samma spår-/händelseidentitet.
- Omförsök leder inte till dubbelbearbetning.
- Om leverantörers händelse-ID:n saknas faller deduplicering tillbaka till en säker nyckel (t.ex. spår-ID) för att undvika att distinkta händelser tappas.

- Gröna:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Röda (förväntade):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing: dmScope-prioritet + identityLinks

**Påstående:** routing måste hålla DM-sessioner isolerade som standard och endast slå samman sessioner när det uttryckligen konfigureras (kanalprioritet + identitetslänkar).

Vad det innebär:

- Kanal-specifika dmScope-överskrivningar måste vinna över globala standardvärden.
- identityLinks ska endast slå samman inom explicit länkade grupper, inte över orelaterade parter.

- Gröna:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Röda (förväntade):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
