---
title: Formele verificatie (beveiligingsmodellen)
summary: Machinaal geverifieerde beveiligingsmodellen voor de hoogste-risicopaden van OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:53Z
---

# Formele verificatie (beveiligingsmodellen)

Deze pagina volgt de **formele beveiligingsmodellen** van OpenClaw (vandaag TLA+/TLC; meer indien nodig).

> Let op: sommige oudere links kunnen verwijzen naar de vorige projectnaam.

**Doel (north star):** een machinaal gecontroleerd betoog leveren dat OpenClaw zijn
beoogde beveiligingsbeleid afdwingt (autorisatie, sessie-isolatie, tool-gating en
veiligheid bij misconfiguratie), onder expliciete aannames.

**Wat dit is (vandaag):** een uitvoerbare, door aanvallers gedreven **beveiligings-regressiesuite**:

- Elke claim heeft een uitvoerbare model-check over een eindige toestandsruimte.
- Veel claims hebben een gekoppeld **negatief model** dat een tegenvoorbeeld-trace oplevert voor een realistische bugklasse.

**Wat dit (nog) niet is:** een bewijs dat “OpenClaw in alle opzichten veilig is” of dat de volledige TypeScript-implementatie correct is.

## Waar de modellen staan

Modellen worden onderhouden in een aparte repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Belangrijke kanttekeningen

- Dit zijn **modellen**, niet de volledige TypeScript-implementatie. Afwijking tussen model en code is mogelijk.
- Resultaten zijn begrensd door de toestandsruimte die door TLC wordt verkend; “groen” impliceert geen veiligheid buiten de gemodelleerde aannames en grenzen.
- Sommige claims steunen op expliciete omgevingsaannames (bijv. correcte deployment, correcte configuratie-invoer).

## Resultaten reproduceren

Vandaag worden resultaten gereproduceerd door de modellen-repo lokaal te klonen en TLC uit te voeren (zie hieronder). Een toekomstige iteratie kan bieden:

- door CI uitgevoerde modellen met publieke artefacten (tegenvoorbeeld-traces, run-logs)
- een gehoste workflow “voer dit model uit” voor kleine, begrensde checks

Aan de slag:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway-blootstelling en open Gateway-misconfiguratie

**Claim:** binden buiten loopback zonder auth kan remote compromittering mogelijk maken / verhoogt blootstelling; token/wachtwoord blokkeren niet-geauthenticeerde aanvallers (volgens de modelaannames).

- Groene runs:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rood (verwacht):
  - `make gateway-exposure-v2-negative`

Zie ook: `docs/gateway-exposure-matrix.md` in de modellen-repo.

### Nodes.run-pijplijn (hoogste-risicocapaciteit)

**Claim:** `nodes.run` vereist (a) een node-opdracht-allowlist plus gedeclareerde opdrachten en (b) live goedkeuring wanneer geconfigureerd; goedkeuringen zijn getokeniseerd om replay te voorkomen (in het model).

- Groene runs:
  - `make nodes-pipeline`
  - `make approvals-token`
- Rood (verwacht):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing store (DM-gating)

**Claim:** pairing-aanvragen respecteren TTL en limieten op het aantal lopende aanvragen.

- Groene runs:
  - `make pairing`
  - `make pairing-cap`
- Rood (verwacht):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress-gating (mentions + omzeiling van control-commands)

**Claim:** in groepscontexten die een mention vereisen, kan een niet-geautoriseerd “control command” de mention-gating niet omzeilen.

- Groen:
  - `make ingress-gating`
- Rood (verwacht):
  - `make ingress-gating-negative`

### Routing-/sessiesleutel-isolatie

**Claim:** DM’s van verschillende peers vallen niet samen in dezelfde sessie, tenzij expliciet gekoppeld/geconfigureerd.

- Groen:
  - `make routing-isolation`
- Rood (verwacht):
  - `make routing-isolation-negative`

## v1++: aanvullende begrensde modellen (concurrentie, retries, trace-correctheid)

Dit zijn vervolgm odellen die de nauwkeurigheid aanscherpen rond realistische faalmodi (niet-atomaire updates, retries en message fan-out).

### Pairing store-concurrentie / idempotentie

**Claim:** een pairing store moet `MaxPending` en idempotentie afdwingen, zelfs onder interleavings (d.w.z. “check-then-write” moet atomair/vergrendeld zijn; refresh mag geen duplicaten creëren).

Wat het betekent:

- Onder gelijktijdige aanvragen kun je `MaxPending` voor een kanaal niet overschrijden.
- Herhaalde aanvragen/verversingen voor dezelfde `(channel, sender)` mogen geen dubbele live pending-rijen creëren.

- Groene runs:
  - `make pairing-race` (atomaire/vergrendelde cap-check)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rood (verwacht):
  - `make pairing-race-negative` (niet-atomaire begin/commit cap-race)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress trace-correlatie / idempotentie

**Claim:** ingestie moet trace-correlatie behouden over fan-out en idempotent zijn onder provider-retries.

Wat het betekent:

- Wanneer één extern event meerdere interne berichten wordt, behoudt elk onderdeel dezelfde trace/event-identiteit.
- Retries leiden niet tot dubbele verwerking.
- Als provider-event-ID’s ontbreken, valt deduplicatie terug op een veilige sleutel (bijv. trace-ID) om te voorkomen dat verschillende events worden gedropt.

- Groen:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Rood (verwacht):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing dmScope-precedentie + identityLinks

**Claim:** routing moet DM-sessies standaard geïsoleerd houden en sessies alleen samenvoegen wanneer dit expliciet is geconfigureerd (kanaal-precedentie + identity links).

Wat het betekent:

- Kanaalspecifieke dmScope-overschrijvingen moeten winnen van globale standaardwaarden.
- identityLinks mogen alleen binnen expliciet gekoppelde groepen samenvoegen, niet over niet-gerelateerde peers.

- Groen:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rood (verwacht):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
