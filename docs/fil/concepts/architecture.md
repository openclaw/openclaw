---
summary: "Arkitektura ng WebSocket gateway, mga component, at mga daloy ng client"
read_when:
  - Nagtatrabaho sa gateway protocol, mga client, o mga transport
title: "Arkitektura ng Gateway"
---

# Arkitektura ng Gateway

Huling na-update: 2026-01-22

## Pangkalahatang-ideya

- Isang iisang pangmatagalang **Gateway** ang may-ari ng lahat ng messaging surfaces (WhatsApp sa pamamagitan ng
  Baileys, Telegram sa pamamagitan ng grammY, Slack, Discord, Signal, iMessage, WebChat).
- Ang mga control‑plane client (macOS app, CLI, web UI, automations) ay kumokonekta sa
  Gateway sa pamamagitan ng **WebSocket** sa naka-configure na bind host (default
  `127.0.0.1:18789`).
- Ang mga **Node** (macOS/iOS/Android/headless) ay kumokonekta rin sa **WebSocket**, ngunit
  nagde-deklara ng `role: node` na may tahasang caps/commands.
- Isang Gateway bawat host; ito lamang ang lugar na nagbubukas ng WhatsApp session.
- Isang **canvas host** (default `18793`) ang nagseserbisyo ng agent‑editable HTML at A2UI.

## Mga component at daloy

### Gateway (daemon)

- Pinananatili ang mga koneksyon ng provider.
- Naglalantad ng typed WS API (mga request, response, at server‑push na event).
- Bine-validate ang mga inbound frame laban sa JSON Schema.
- Nag-e-emit ng mga event tulad ng `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`.

### Mga client (mac app / CLI / web admin)

- Isang WS connection bawat client.
- Nagpapadala ng mga request (`health`, `status`, `send`, `agent`, `system-presence`).
- Nag-su-subscribe sa mga event (`tick`, `agent`, `presence`, `shutdown`).

### Mga Node (macOS / iOS / Android / headless)

- Kumokonekta sa **parehong WS server** na may `role: node`.
- Nagbibigay ng device identity sa `connect`; ang pairing ay **device‑based** (role `node`) at
  ang pag-apruba ay nasa device pairing store.
- Naglalantad ng mga command tulad ng `canvas.*`, `camera.*`, `screen.record`, `location.get`.

Mga detalye ng protocol:

- [Gateway protocol](/gateway/protocol)

### WebChat

- Static UI na gumagamit ng Gateway WS API para sa chat history at pagpapadala.
- Sa mga remote setup, kumokonekta sa parehong SSH/Tailscale tunnel tulad ng ibang
  mga client.

## Lifecycle ng koneksyon (iisang client)

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

## Wire protocol (buod)

- Transport: WebSocket, text frames na may JSON payload.
- Ang unang frame **dapat** ay `connect`.
- Pagkatapos ng handshake:
  - Mga request: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Mga event: `{type:"event", event, payload, seq?, stateVersion?}`
- Kung naka-set ang `OPENCLAW_GATEWAY_TOKEN` (o `--token`), ang `connect.params.auth.token`
  ay dapat tumugma o isasara ang socket.
- Kinakailangan ang mga idempotency key para sa mga method na may side effect (`send`, `agent`) upang
  ligtas na makapag-retry; ang server ay nagpapanatili ng panandaliang dedupe cache.
- Dapat isama ng mga Node ang `role: "node"` kasama ang caps/commands/permissions sa `connect`.

## Pairing + lokal na tiwala

- Lahat ng WS client (operators + nodes) ay nagsasama ng **device identity** sa `connect`.
- Ang mga bagong device ID ay nangangailangan ng pag-apruba sa pairing; ang Gateway ay nag-iisyu ng **device token**
  para sa mga susunod na koneksyon.
- Ang mga **lokal** na koneksyon (loopback o sariling tailnet address ng gateway host) ay maaaring
  auto‑approved upang manatiling maayos ang UX sa parehong host.
- Ang mga **hindi lokal** na koneksyon ay dapat pumirma sa `connect.challenge` nonce at nangangailangan ng
  tahasang pag-apruba.
- Ang Gateway auth (`gateway.auth.*`) ay nananatiling naaangkop sa **lahat** ng koneksyon, lokal man o
  remote.

Mga detalye: [Gateway protocol](/gateway/protocol), [Pairing](/channels/pairing),
[Security](/gateway/security).

## Protocol typing at codegen

- Ang mga TypeBox schema ang naglalarawan ng protocol.
- Ang JSON Schema ay binubuo mula sa mga schema na iyon.
- Ang mga Swift model ay binubuo mula sa JSON Schema.

## Remote access

- Inirerekomenda: Tailscale o VPN.

- Alternatibo: SSH tunnel

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Ang parehong handshake + auth token ay naaangkop sa ibabaw ng tunnel.

- Maaaring paganahin ang TLS + opsyonal na pinning para sa WS sa mga remote setup.

## Snapshot ng operasyon

- Simula: `openclaw gateway` (foreground, nagla-log sa stdout).
- Kalusugan: `health` sa pamamagitan ng WS (kasama rin sa `hello-ok`).
- Supervision: launchd/systemd para sa auto‑restart.

## Mga invariant

- Eksaktong isang Gateway ang kumokontrol sa isang Baileys session bawat host.
- Sapilitan ang handshake; anumang non‑JSON o non‑connect na unang frame ay agarang isasara.
- Ang mga event ay hindi nire-replay; dapat mag-refresh ang mga client kapag may gap.
