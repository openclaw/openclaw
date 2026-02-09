---
summary: "Bridge-protocol (legacy nodes): TCP JSONL, koppeling, scoped RPC"
read_when:
  - Het bouwen of debuggen van node-clients (iOS/Android/macOS node-modus)
  - Het onderzoeken van koppelings- of bridge-authenticatiefouten
  - Het auditen van het node-oppervlak dat door de gateway wordt blootgesteld
title: "Bridge-protocol"
---

# Bridge-protocol (legacy node-transport)

Het Bridge-protocol is een **legacy** node-transport (TCP JSONL). Nieuwe node-clients
moeten in plaats daarvan het uniforme Gateway WebSocket-protocol gebruiken.

Als je een operator of node-client bouwt, gebruik het
[Gateway-protocol](/gateway/protocol).

**Let op:** Huidige OpenClaw-builds leveren de TCP-bridge-listener niet langer mee; dit document wordt bewaard ter historische referentie.
Legacy `bridge.*`-config-sleutels maken geen deel meer uit van het config-schema.

## Waarom we beide hebben

- **Beveiligingsgrens**: de bridge stelt een kleine toegestane lijst bloot in plaats van het
  volledige gateway-API-oppervlak.
- **Koppeling + node-identiteit**: toelating van nodes is eigendom van de gateway en gekoppeld
  aan een per-node token.
- **Discovery-UX**: nodes kunnen gateways ontdekken via Bonjour op LAN, of
  direct verbinden via een tailnet.
- **Loopback WS**: het volledige WS-control plane blijft lokaal, tenzij getunneld via SSH.

## Transport

- TCP, één JSON-object per regel (JSONL).
- Optionele TLS (wanneer `bridge.tls.enabled` true is).
- De legacy standaard listener-poort was `18790` (huidige builds starten geen TCP-bridge).

Wanneer TLS is ingeschakeld, bevatten discovery TXT-records `bridgeTls=1` plus
`bridgeTlsSha256`, zodat nodes het certificaat kunnen pinnen.

## Handshake + koppeling

1. Client verzendt `hello` met node-metadata + token (indien al gekoppeld).
2. Indien niet gekoppeld, antwoordt de gateway met `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Client verzendt `pair-request`.
4. De gateway wacht op goedkeuring en verzendt vervolgens `pair-ok` en `hello-ok`.

`hello-ok` retourneert `serverName` en kan `canvasHostUrl` bevatten.

## Frames

Client → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessies, config, health, voicewake, skills.bins)
- `event`: node-signalen (spraaktranscript, agent-aanvraag, chat-abonnement, exec-levenscyclus)

Gateway → Client:

- `invoke` / `invoke-res`: node-opdrachten (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chat-updates voor geabonneerde sessies
- `ping` / `pong`: keepalive

Legacy afdwinging van de toegestane lijst leefde in `src/gateway/server-bridge.ts` (verwijderd).

## Exec-levenscyclusgebeurtenissen

Nodes kunnen `exec.finished`- of `exec.denied`-gebeurtenissen uitsturen om system.run-activiteit zichtbaar te maken.
Deze worden in de gateway gemapt naar systeemgebeurtenissen. (Legacy nodes kunnen nog steeds `exec.started` uitsturen.)

Payload-velden (alle optioneel tenzij vermeld):

- `sessionKey` (vereist): agent-sessie om de systeemgebeurtenis te ontvangen.
- `runId`: unieke exec-id voor groepering.
- `command`: ruwe of geformatteerde opdrachtstring.
- `exitCode`, `timedOut`, `success`, `output`: afrondingsdetails (alleen voltooid).
- `reason`: reden van weigering (alleen geweigerd).

## Tailnet-gebruik

- Bind de bridge aan een tailnet-IP: `bridge.bind: "tailnet"` in
  `~/.openclaw/openclaw.json`.
- Clients verbinden via MagicDNS-naam of tailnet-IP.
- Bonjour overschrijdt **geen** netwerken; gebruik zo nodig handmatige host/poort of wide-area DNS‑SD.

## Versionering

Bridge is momenteel **impliciet v1** (geen min/max-onderhandeling). Backward-compatibiliteit
wordt verwacht; voeg een bridge-protocolversieveld toe vóór eventuele breaking changes.
