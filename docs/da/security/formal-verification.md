---
title: Formel verifikation (sikkerhedsmodeller)
summary: Maskinverificerede sikkerhedsmodeller for OpenClaws mest risikofyldte forløb.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:50Z
---

# Formel verifikation (sikkerhedsmodeller)

Denne side følger OpenClaws **formelle sikkerhedsmodeller** (TLA+/TLC i dag; flere efter behov).

> Bemærk: nogle ældre links kan henvise til det tidligere projektnavn.

**Mål (north star):** at levere et maskinverificeret argument for, at OpenClaw håndhæver sin
tiltænkte sikkerhedspolitik (autorisering, sessionsisolering, værktøjsafgrænsning og
sikkerhed ved fejlkonfiguration), under eksplicitte antagelser.

**Hvad dette er (i dag):** en eksekverbar, angriber-drevet **sikkerheds-regressionssuite**:

- Hver påstand har et kørbart model-check over et endeligt tilstandsrum.
- Mange påstande har en parret **negativ model**, der producerer et modbevis-spor for en realistisk bug-klasse.

**Hvad dette ikke er (endnu):** et bevis for, at “OpenClaw er sikker i alle henseender”, eller at den fulde TypeScript-implementering er korrekt.

## Hvor modellerne ligger

Modeller vedligeholdes i et separat repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Vigtige forbehold

- Dette er **modeller**, ikke den fulde TypeScript-implementering. Afvigelser mellem model og kode er mulige.
- Resultater er begrænset af det tilstandsrum, som TLC udforsker; “grønt” indebærer ikke sikkerhed ud over de modellerede antagelser og grænser.
- Nogle påstande afhænger af eksplicitte miljøantagelser (fx korrekt deployment, korrekte konfigurationsinput).

## Genskabelse af resultater

I dag genskabes resultater ved at klone models-repoet lokalt og køre TLC (se nedenfor). En fremtidig iteration kan tilbyde:

- CI-kørte modeller med offentlige artefakter (modbevis-spor, kørselslogs)
- et hostet “kør denne model”-workflow for små, afgrænsede checks

Kom godt i gang:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway-eksponering og åben gateway-fejlkonfiguration

**Påstand:** binding ud over loopback uden auth kan gøre fjernkompromittering mulig / øger eksponeringen; token/adgangskode blokerer uautoriserede angribere (ifølge modelantagelserne).

- Grønne kørsler:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rød (forventet):
  - `make gateway-exposure-v2-negative`

Se også: `docs/gateway-exposure-matrix.md` i models-repoet.

### Nodes.run-pipeline (højeste risikokapacitet)

**Påstand:** `nodes.run` kræver (a) tilladelsesliste for node-kommandoer plus deklarerede kommandoer og (b) live-godkendelse, når det er konfigureret; godkendelser er tokeniserede for at forhindre replay (i modellen).

- Grønne kørsler:
  - `make nodes-pipeline`
  - `make approvals-token`
- Rød (forventet):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing store (DM-afgrænsning)

**Påstand:** pairing-anmodninger respekterer TTL og lofter for ventende anmodninger.

- Grønne kørsler:
  - `make pairing`
  - `make pairing-cap`
- Rød (forventet):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress-afgrænsning (mentions + omgåelse af kontrolkommando)

**Påstand:** i gruppe-kontekster, der kræver mention, kan en uautoriseret “kontrolkommando” ikke omgå mention-afgrænsning.

- Grøn:
  - `make ingress-gating`
- Rød (forventet):
  - `make ingress-gating-negative`

### Routing/session-nøgle-isolering

**Påstand:** DMs fra forskellige peers kollapser ikke til samme session, medmindre de eksplicit linkes/konfigureres.

- Grøn:
  - `make routing-isolation`
- Rød (forventet):
  - `make routing-isolation-negative`

## v1++: yderligere afgrænsede modeller (konkurrence, retries, spor-korrekthed)

Dette er opfølgende modeller, der strammer realismen omkring virkelige fejltilstande (ikke-atomare opdateringer, retries og fan-out af beskeder).

### Pairing store-konkurrence / idempotens

**Påstand:** en pairing store bør håndhæve `MaxPending` og idempotens selv under interleavings (dvs. “check-then-write” skal være atomisk/låst; refresh bør ikke skabe dubletter).

Hvad det betyder:

- Under samtidige anmodninger kan du ikke overskride `MaxPending` for en kanal.
- Gentagne anmodninger/refreshes for den samme `(channel, sender)` bør ikke skabe duplikerede, aktive ventende rækker.

- Grønne kørsler:
  - `make pairing-race` (atomisk/låst loft-check)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rød (forventet):
  - `make pairing-race-negative` (ikke-atomar begin/commit loft-race)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress spor-korrelation / idempotens

**Påstand:** ingestion bør bevare spor-korrelation på tværs af fan-out og være idempotent under udbyder-retries.

Hvad det betyder:

- Når én ekstern hændelse bliver til flere interne beskeder, bevarer alle dele samme spor-/hændelsesidentitet.
- Retries resulterer ikke i dobbeltbehandling.
- Hvis udbyderens hændelses-id’er mangler, falder deduplikering tilbage til en sikker nøgle (fx spor-id) for at undgå at droppe distinkte hændelser.

- Grøn:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Rød (forventet):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing dmScope-præcedens + identityLinks

**Påstand:** routing skal holde DM-sessioner isoleret som standard og kun kollapse sessioner, når det er eksplicit konfigureret (kanalpræcedens + identity links).

Hvad det betyder:

- Kanal-specifikke dmScope-overskrivninger skal vinde over globale standarder.
- identityLinks bør kun kollapse inden for eksplicit linkede grupper, ikke på tværs af urelaterede peers.

- Grøn:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rød (forventet):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
