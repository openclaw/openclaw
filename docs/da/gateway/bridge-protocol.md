---
summary: "Bridge-protokol (legacy-noder): TCP JSONL, parring, scoped RPC"
read_when:
  - Opbygning eller fejlfinding af nodeklienter (iOS/Android/macOS node-tilstand)
  - Undersøgelse af parring eller fejl i bridge-godkendelse
  - Revision af node-overfladen, der eksponeres af gatewayen
title: "Bridge-protokol"
---

# Bridge-protokol (legacy node-transport)

Broprotokollen er en **legacy** node transport (TCP JSONL). Nye node klienter
bør i stedet bruge den samlede Gateway WebSocket protokol.

Hvis du bygger en operatør- eller nodeklient, skal du bruge
[Gateway-protokollen](/gateway/protocol).

**Bemærk:** Nuværende OpenClaw bygger sender ikke længere TCP-broens lytter; dette dokument opbevares til historisk reference.
Legacy `bridge.*` config nøgler er ikke længere en del af config skema.

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

Knuder kan udsende `exec.finished` eller `exec.denied` begivenheder til overflade system.run aktivitet.
Disse er knyttet til systembegivenheder i gatewayen. (Ældre knuder kan stadig udsende `exec.started`.)

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

Broen er i øjeblikket **implicit v1** (ingen min/max forhandling). Bagud-compat
forventes; tilføj en bro protokol versionsfelt før eventuelle brydende ændringer.
