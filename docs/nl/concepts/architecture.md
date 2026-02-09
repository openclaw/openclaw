---
summary: "WebSocket-Gateway-architectuur, componenten en clientstromen"
read_when:
  - Werken aan gatewayprotocol, clients of transports
title: "Gateway-architectuur"
---

# Gateway-architectuur

Laatst bijgewerkt: 2026-01-22

## Overzicht

- Eén enkele langlevende **Gateway** beheert alle berichtoppervlakken (WhatsApp via
  Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).
- Control-plane-clients (macOS-app, CLI, web-UI, automatiseringen) verbinden met de
  Gateway via **WebSocket** op de geconfigureerde bind-host (standaard
  `127.0.0.1:18789`).
- **Nodes** (macOS/iOS/Android/headless) verbinden ook via **WebSocket**, maar
  declareren `role: node` met expliciete caps/opdrachten.
- Eén Gateway per host; dit is de enige plek die een WhatsApp-sessie opent.
- Een **canvas host** (standaard `18793`) serveert door agents bewerkbare HTML en A2UI.

## Componenten en stromen

### Gateway (daemon)

- Onderhoudt providerverbindingen.
- Stelt een getypeerde WS-API beschikbaar (requests, responses, server-push-events).
- Valideert inkomende frames tegen JSON Schema.
- Zendt events uit zoals `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Clients (mac-app / CLI / webbeheer)

- Eén WS-verbinding per client.
- Verzenden requests (`health`, `status`, `send`, `agent`, `system-presence`).
- Abonneren zich op events (`tick`, `agent`, `presence`, `shutdown`).

### Nodes (macOS / iOS / Android / headless)

- Verbinden met **dezelfde WS-server** met `role: node`.
- Leveren een apparaatidentiteit in `connect`; koppeling is **apparaat‑gebaseerd** (rol `node`) en
  goedkeuring leeft in de apparaatkoppelingsopslag.
- Stellen opdrachten beschikbaar zoals `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Protocoldetails:

- [Gateway protocol](/gateway/protocol)

### WebChat

- Statische UI die de Gateway WS-API gebruikt voor chatgeschiedenis en verzenden.
- In remote-opstellingen verbindt via dezelfde SSH/Tailscale-tunnel als andere
  clients.

## Verbindingslevenscyclus (enkele client)

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

## Wire-protocol (samenvatting)

- Transport: WebSocket, tekstframes met JSON-payloads.
- Eerste frame **moet** `connect` zijn.
- Na de handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Als `OPENCLAW_GATEWAY_TOKEN` (of `--token`) is ingesteld, `connect.params.auth.token`
  moet overeenkomen, anders sluit de socket.
- Idempotentiesleutels zijn vereist voor methoden met neveneffecten (`send`, `agent`) om
  veilig te kunnen herhalen; de server houdt een kortlevende deduplicatiecache bij.
- Nodes moeten `role: "node"` opnemen plus caps/opdrachten/rechten in `connect`.

## Koppeling + lokaal vertrouwen

- Alle WS-clients (operators + nodes) nemen een **apparaatidentiteit** op in `connect`.
- Nieuwe apparaat-ID’s vereisen koppelingsgoedkeuring; de Gateway geeft een **apparaat-token**
  uit voor volgende verbindingen.
- **Lokale** verbindingen (loopback of het eigen tailnet-adres van de Gateway-host) kunnen
  automatisch worden goedgekeurd om de UX op dezelfde host soepel te houden.
- **Niet-lokale** verbindingen moeten de `connect.challenge`-nonce ondertekenen en vereisen
  expliciete goedkeuring.
- Gateway-auth (`gateway.auth.*`) blijft van toepassing op **alle** verbindingen, lokaal of
  op afstand.

Details: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),
[Security](/gateway/security).

## Protocoltypering en codegeneratie

- TypeBox-schema’s definiëren het protocol.
- JSON Schema wordt gegenereerd uit die schema’s.
- Swift-modellen worden gegenereerd uit het JSON Schema.

## Toegang op afstand

- Voorkeur: Tailscale of VPN.

- Alternatief: SSH-tunnel

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Dezelfde handshake + auth-token zijn van toepassing over de tunnel.

- TLS + optionele pinning kan worden ingeschakeld voor WS in remote-opstellingen.

## Operationeel overzicht

- Starten: `openclaw gateway` (foreground, logt naar stdout).
- Health: `health` via WS (ook opgenomen in `hello-ok`).
- Supervisie: launchd/systemd voor automatisch herstarten.

## Invarianten

- Precies één Gateway beheert één enkele Baileys-sessie per host.
- Handshake is verplicht; elk niet-JSON- of niet-connect-eerste frame resulteert in een harde sluiting.
- Events worden niet opnieuw afgespeeld; clients moeten bij hiaten verversen.
