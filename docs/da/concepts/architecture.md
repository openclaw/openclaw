---
summary: "WebSocket-gatewayarkitektur, komponenter og klientflows"
read_when:
  - Arbejder med gateway-protokol, klienter eller transporter
title: "Gateway-arkitektur"
---

# Gateway-arkitektur

Senest opdateret: 2026-01-22

## Overblik

- En enkelt langlivet **Gateway** ejer alle messaging‑overflader (WhatsApp via
  Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).
- Control‑plane‑klienter (macOS‑app, CLI, web‑UI, automatiseringer) forbinder til
  Gateway via **WebSocket** på den konfigurerede bind‑vært (standard
  `127.0.0.1:18789`).
- **Noder** (macOS/iOS/Android/headless) forbinder også via **WebSocket**, men
  deklarerer `role: node` med eksplicitte kapabiliteter/kommandoer.
- Én Gateway pr. vært; det er det eneste sted, der åbner en WhatsApp‑session.
- En **canvas‑vært** (standard `18793`) serverer agent‑redigerbar HTML og A2UI.

## Komponenter og flows

### Gateway (daemon)

- Vedligeholder udbyderforbindelser.
- Eksponerer et typet WS‑API (forespørgsler, svar, server‑push‑events).
- Validerer indgående frames mod JSON Schema.
- Udsender events som `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Klienter (mac‑app / CLI / web‑admin)

- Én WS‑forbindelse pr. klient.
- Sender forespørgsler (`health`, `status`, `send`, `agent`, `system-presence`).
- Abonnerer på events (`tick`, `agent`, `presence`, `shutdown`).

### Noder (macOS / iOS / Android / headless)

- Forbinder til **den samme WS‑server** med `role: node`.
- Angiver en enhedsidentitet i `connect`; parring er **enhedsbaseret** (rolle `node`), og
  godkendelse ligger i enhedsparringslageret.
- Eksponerer kommandoer som `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Protokoldetaljer:

- [Gateway-protokol](/gateway/protocol)

### WebChat

- Statisk UI, der bruger Gateway‑WS‑API’et til chathistorik og afsendelser.
- I fjernopsætninger forbinder den via den samme SSH/Tailscale‑tunnel som andre
  klienter.

## Forbindelseslivscyklus (enkelt klient)

```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health)
  |                          |
  |<------ event:presence ---|
  |<------ event:tick -------|
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```

## Wire‑protokol (resume)

- Transport: WebSocket, tekstframes med JSON‑payloads.
- Første frame **skal** være `connect`.
- Efter handshake:
  - Forespørgsler: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Hvis `OPENCLAW_GATEWAY_TOKEN` (eller `--token`) er sat, `connect.params.auth.token`
  skal matche, ellers lukkes socketten.
- Idempotensnøgler er påkrævet for metoder med sideeffekter (`send`, `agent`) for
  sikker genforsøg; serveren holder en kortlivet dedupe‑cache.
- Noder skal inkludere `role: "node"` samt kapabiliteter/kommandoer/tilladelser i `connect`.

## Parring + lokal tillid

- Alle WS‑klienter (operatører + noder) inkluderer en **enhedsidentitet** i `connect`.
- Nye enheds‑ID’er kræver parringsgodkendelse; Gateway udsteder et **enhedstoken**
  til efterfølgende forbindelser.
- **Lokale** forbindelser (loopback eller gateway‑værtens egen tailnet‑adresse) kan
  auto‑godkendes for at holde samme‑vært‑UX glat.
- **Ikke‑lokale** forbindelser skal signere `connect.challenge`‑nonce og kræver
  eksplicit godkendelse.
- Gateway‑autentificering (`gateway.auth.*`) gælder stadig for **alle** forbindelser, lokale eller
  fjernforbindelser.

Detaljer: [Gateway-protokol](/gateway/protocol), [Parring](/channels/pairing),
[Sikkerhed](/gateway/security).

## Protokoltypning og codegen

- TypeBox‑skemaer definerer protokollen.
- JSON Schema genereres fra disse skemaer.
- Swift‑modeller genereres fra JSON Schema.

## Fjernadgang

- Foretrukket: Tailscale eller VPN.

- Alternativ: SSH‑tunnel

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Den samme handshake + auth‑token gælder over tunnelen.

- TLS + valgfri pinning kan aktiveres for WS i fjernopsætninger.

## Driftsoversigt

- Start: `openclaw gateway` (forgrund, logger til stdout).
- Sundhed: `health` over WS (også inkluderet i `hello-ok`).
- Overvågning: launchd/systemd for auto‑genstart.

## Invarianter

- Præcis én Gateway styrer én Baileys‑session pr. vært.
- Handshake er obligatorisk; enhver ikke‑JSON eller ikke‑connect som første frame medfører hård lukning.
- Events afspilles ikke igen; klienter skal opdatere ved huller.
