---
title: Pormal na Beripikasyon (Mga Modelong Pangseguridad)
summary: Mga modelong pangseguridad na sinuri ng makina para sa mga landasing may pinakamataas na panganib ng OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:03Z
---

# Pormal na Beripikasyon (Mga Modelong Pangseguridad)

Sinusubaybayan ng pahinang ito ang **mga pormal na modelong pangseguridad** ng OpenClaw (TLA+/TLC sa ngayon; higit pa kung kinakailangan).

> Paalala: maaaring tumukoy ang ilang mas lumang link sa dating pangalan ng proyekto.

**Layunin (north star):** magbigay ng isang argumentong sinuri ng makina na ipinapatupad ng OpenClaw ang
nilalayon nitong patakarang pangseguridad (authorization, session isolation, tool gating, at
kaligtasan laban sa misconfiguration), sa ilalim ng malinaw na mga palagay.

**Ano ito (sa ngayon):** isang executable, attacker-driven **security regression suite**:

- Ang bawat claim ay may naipapatakbong model-check sa isang may hangganang state space.
- Maraming claim ang may kaparehong **negative model** na gumagawa ng counterexample trace para sa isang makatotohanang klase ng bug.

**Ano ito hindi (pa):** isang patunay na “secure ang OpenClaw sa lahat ng aspeto” o na tama ang buong TypeScript implementation.

## Saan nakalagay ang mga modelo

Ang mga modelo ay pinapanatili sa isang hiwalay na repo: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Mahahalagang paalala

- Ito ay mga **modelo**, hindi ang buong TypeScript implementation. Posible ang paglihis sa pagitan ng modelo at code.
- Ang mga resulta ay limitado ng state space na sinuri ng TLC; ang pagiging “green” ay hindi nangangahulugang may seguridad lampas sa mga modelong palagay at hangganan.
- Ang ilang claim ay umaasa sa malinaw na mga palagay tungkol sa kapaligiran (hal., tamang deployment, tamang config inputs).

## Pag-uulit ng mga resulta

Sa ngayon, inuulit ang mga resulta sa pamamagitan ng pag-clone ng models repo nang lokal at pagpapatakbo ng TLC (tingnan sa ibaba). Sa hinaharap, maaaring mag-alok ng:

- Mga modelong pinapatakbo ng CI na may pampublikong artifacts (mga counterexample trace, run logs)
- Isang naka-host na workflow na “patakbuhin ang modelong ito” para sa maliliit at may hangganang pagsusuri

Pagsisimula:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway exposure at open gateway misconfiguration

**Claim:** ang pag-bind lampas sa loopback nang walang auth ay maaaring magbigay-daan sa remote compromise / nagpapataas ng exposure; hinaharangan ng token/password ang mga hindi awtorisadong attacker (ayon sa mga palagay ng modelo).

- Green runs:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Red (inaasahan):
  - `make gateway-exposure-v2-negative`

Tingnan din: `docs/gateway-exposure-matrix.md` sa models repo.

### Nodes.run pipeline (pinakamataas na panganib na kakayahan)

**Claim:** `nodes.run` ay nangangailangan ng (a) node command allowlist kasama ang mga idineklarang command at (b) live approval kapag naka-configure; ang mga approval ay tokenized upang maiwasan ang replay (sa modelo).

- Green runs:
  - `make nodes-pipeline`
  - `make approvals-token`
- Red (inaasahan):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing store (DM gating)

**Claim:** iginagalang ng mga pairing request ang TTL at mga cap ng pending-request.

- Green runs:
  - `make pairing`
  - `make pairing-cap`
- Red (inaasahan):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress gating (mentions + control-command bypass)

**Claim:** sa mga group context na nangangailangan ng mention, hindi maaaring lampasan ng isang hindi awtorisadong “control command” ang mention gating.

- Green:
  - `make ingress-gating`
- Red (inaasahan):
  - `make ingress-gating-negative`

### Routing/session-key isolation

**Claim:** ang mga DM mula sa magkakaibang peer ay hindi nagsasama sa iisang session maliban kung tahasang na-link/naka-configure.

- Green:
  - `make routing-isolation`
- Red (inaasahan):
  - `make routing-isolation-negative`

## v1++: mga karagdagang bounded model (concurrency, retries, trace correctness)

Ito ay mga kasunod na modelo na pinahihigpit ang fidelity kaugnay ng mga failure mode sa totoong mundo (non-atomic updates, retries, at message fan-out).

### Pairing store concurrency / idempotency

**Claim:** dapat ipatupad ng pairing store ang `MaxPending` at idempotency kahit sa ilalim ng interleavings (ibig sabihin, ang “check-then-write” ay dapat atomic / naka-lock; ang refresh ay hindi dapat lumikha ng mga duplicate).

Ano ang ibig sabihin nito:

- Sa ilalim ng sabayang mga request, hindi mo maaaring lampasan ang `MaxPending` para sa isang channel.
- Ang paulit-ulit na mga request/refresh para sa parehong `(channel, sender)` ay hindi dapat lumikha ng mga duplicate na live pending row.

- Green runs:
  - `make pairing-race` (atomic/locked cap check)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Red (inaasahan):
  - `make pairing-race-negative` (non-atomic begin/commit cap race)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress trace correlation / idempotency

**Claim:** dapat mapanatili ng ingestion ang trace correlation sa buong fan-out at maging idempotent sa ilalim ng provider retries.

Ano ang ibig sabihin nito:

- Kapag ang isang external event ay nagiging maraming internal message, pinananatili ng bawat bahagi ang parehong trace/event identity.
- Ang mga retry ay hindi nagreresulta sa dobleng pagproseso.
- Kung nawawala ang provider event IDs, ang dedupe ay bumabalik sa isang ligtas na key (hal., trace ID) upang maiwasan ang pagbagsak ng magkakaibang event.

- Green:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Red (inaasahan):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing dmScope precedence + identityLinks

**Claim:** dapat panatilihing hiwalay ng routing ang mga DM session bilang default, at pagsamahin lamang ang mga session kapag tahasang naka-configure (channel precedence + identity links).

Ano ang ibig sabihin nito:

- Dapat manaig ang mga override ng dmScope na partikular sa channel laban sa mga global default.
- Dapat magsanib ang identityLinks sa loob lamang ng tahasang naka-link na mga grupo, hindi sa magkakahiwalay na peer.

- Green:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Red (inaasahan):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
