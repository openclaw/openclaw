---
summary: "Bridge-protokol (legacy-noder): TCP JSONL, parring, scoped RPC"
read_when:
  - Opbygning eller fejlfinding af nodeklienter (iOS/Android/macOS node-tilstand)
  - Undersøgelse af parring eller fejl i bridge-godkendelse
  - Revision af node-overfladen, der eksponeres af gatewayen
title: "Bridge-protokol"
x-i18n:
  source_path: gateway/bridge-protocol.md
  source_hash: 789bcf3cbc6841fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:16Z
---

# Bridge-protokol (legacy node-transport)

Bridge-protokollen er en **legacy** node-transport (TCP JSONL). Nye nodeklienter
bør i stedet bruge den samlede Gateway WebSocket-protokol.

Hvis du bygger en operatør- eller nodeklient, skal du bruge
[Gateway-protokollen](/gateway/protocol).

**Bemærk:** Aktuelle OpenClaw-builds leveres ikke længere med TCP bridge-listeneren; dette dokument bevares af historiske årsager.
Legacy `bridge.*` konfigurationsnøgler er ikke længere en del af konfigurationsskemaet.

## Hvorfor vi har begge dele

- **Sikkerhedsgrænse**: bridgen eksponerer en lille tilladelsesliste i stedet for
  hele gateway-API-overfladen.
- **Parring + node-identitet**: node-adgang styres af gatewayen og er knyttet
  til et token pr. node.
- **Discovery UX**: noder kan finde gateways via Bonjour på LAN eller forbinde
  direkte over et tailnet.
- **Loopback WS**: det fulde WS-kontrolplan forbliver lokalt, medmindre det tunnels via SSH.

## Transport

- TCP, ét JSON-objekt pr. linje (JSONL).
- Valgfri TLS (når `bridge.tls.enabled` er true).
- Legacy standard-lytterport var `18790` (aktuelle builds starter ikke en TCP bridge).

Når TLS er aktiveret, inkluderer discovery TXT-poster `bridgeTls=1` plus
`bridgeTlsSha256`, så noder kan pinne certifikatet.

## Handshake + parring

1. Klienten sender `hello` med node-metadata + token (hvis allerede parret).
2. Hvis ikke parret, svarer gatewayen med `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Klienten sender `pair-request`.
4. Gatewayen afventer godkendelse og sender derefter `pair-ok` og `hello-ok`.

`hello-ok` returnerer `serverName` og kan inkludere `canvasHostUrl`.

## Frames

Klient → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: node-signaler (stemmetransskription, agent-anmodning, chat-abonnement, exec-livscyklus)

Gateway → Klient:

- `invoke` / `invoke-res`: node-kommandoer (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chat-opdateringer for abonnerede sessioner
- `ping` / `pong`: keepalive

Legacy håndhævelse af tilladelsesliste lå i `src/gateway/server-bridge.ts` (fjernet).

## Exec-livscyklusbegivenheder

Noder kan udsende `exec.finished` eller `exec.denied`-begivenheder for at eksponere system.run-aktivitet.
Disse mappes til systembegivenheder i gatewayen. (Legacy-noder kan stadig udsende `exec.started`.)

Payload-felter (alle valgfri, medmindre andet er angivet):

- `sessionKey` (påkrævet): agent-session, der skal modtage systembegivenheden.
- `runId`: unikt exec-id til gruppering.
- `command`: rå eller formateret kommandostreng.
- `exitCode`, `timedOut`, `success`, `output`: færdiggørelsesdetaljer (kun ved afsluttet).
- `reason`: afvisningsårsag (kun ved afvist).

## Tailnet-brug

- Bind bridgen til en tailnet-IP: `bridge.bind: "tailnet"` i
  `~/.openclaw/openclaw.json`.
- Klienter forbinder via MagicDNS-navn eller tailnet-IP.
- Bonjour krydser **ikke** netværk; brug manuel vært/port eller DNS‑SD over WAN
  efter behov.

## Versionering

Bridge er i øjeblikket **implicit v1** (ingen min/maks-forhandling). Bagudkompatibilitet
forventes; tilføj et bridge-protokolversionsfelt før eventuelle breaking changes.
