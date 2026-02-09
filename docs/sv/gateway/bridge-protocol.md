---
summary: "Bridge-protokoll (äldre noder): TCP JSONL, parkoppling, avgränsad RPC"
read_when:
  - Bygger eller felsöker nodklienter (iOS/Android/macOS nodläge)
  - Utreder parkopplings- eller bridge‑autentiseringsfel
  - Granskar nodytan som exponeras av gatewayn
title: "Bridge-protokoll"
---

# Bridge-protokoll (äldre nodtransport)

Bro protokollet är en **legacy** nod transport (TCP JSONL). Nya nodklienter
bör använda det enhetliga Gateway WebSocket-protokollet istället.

Om du bygger en operatör eller nodklient, använd
[Gateway-protokollet](/gateway/protocol).

**Observera:** Nuvarande OpenClaw bygger skickar inte längre TCP-brygglyssnaren, detta dokument hålls för historisk referens.
Legacy `bridge.*` config nycklar är inte längre en del av konfigurationsschemat.

## Varför vi har båda

- **Säkerhetsgräns**: bridgen exponerar en liten tillåtelselista i stället för
  hela gatewayns API‑yta.
- **Parkoppling + nodidentitet**: nodantagning ägs av gatewayn och är knuten
  till en per‑nod‑token.
- **Discovery‑UX**: noder kan upptäcka gateways via Bonjour på LAN, eller ansluta
  direkt över ett tailnet.
- **Loopback WS**: hela WS‑kontrollplanet förblir lokalt om det inte tunnlas via SSH.

## Transport

- TCP, ett JSON‑objekt per rad (JSONL).
- Valfri TLS (när `bridge.tls.enabled` är true).
- Äldre standardlyssnarport var `18790` (aktuella byggen startar inte en TCP‑bridge).

När TLS är aktiverat inkluderar discovery‑TXT‑poster `bridgeTls=1` samt
`bridgeTlsSha256` så att noder kan pina certifikatet.

## Handshake + parkoppling

1. Klienten skickar `hello` med nodmetadata + token (om redan parkopplad).
2. Om inte parkopplad svarar gatewayn med `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Klienten skickar `pair-request`.
4. Gatewayn väntar på godkännande och skickar därefter `pair-ok` och `hello-ok`.

`hello-ok` returnerar `serverName` och kan inkludera `canvasHostUrl`.

## Ramar

Klient → Gateway:

- `req` / `res`: avgränsad gateway‑RPC (chatt, sessioner, konfig, hälsa, voicewake, skills.bins)
- `event`: nodsignaler (rösttranskript, agentbegäran, chattprenumeration, exec‑livscykel)

Gateway → Klient:

- `invoke` / `invoke-res`: nodkommandon (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: chattuppdateringar för prenumererade sessioner
- `ping` / `pong`: keepalive

Äldre tillåtelseliste‑tillämpning låg i `src/gateway/server-bridge.ts` (borttagen).

## Exec‑livscykelhändelser

Noder kan sända ut `exec.finished` eller `exec.denied` händelser till ytans system.run aktivitet.
Dessa kartläggs till systemhändelser i porten. (Legacy noder kan fortfarande avge `exec.started`.)

Payload‑fält (alla valfria om inget annat anges):

- `sessionKey` (obligatoriskt): agentsession som ska ta emot systemhändelsen.
- `runId`: unikt exec‑id för gruppering.
- `command`: rå eller formaterad kommandosträng.
- `exitCode`, `timedOut`, `success`, `output`: avslutningsdetaljer (endast vid färdig).
- `reason`: orsak till nekande (endast vid nekad).

## Tailnet‑användning

- Bind bridgen till en tailnet‑IP: `bridge.bind: "tailnet"` i
  `~/.openclaw/openclaw.json`.
- Klienter ansluter via MagicDNS‑namn eller tailnet‑IP.
- Bonjour korsar **inte** nätverk; använd manuell värd/port eller DNS‑SD för breda nät
  när det behövs.

## Versionering

Bridge är för närvarande **implicit v1** (ingen min/max förhandling). Bakåt-compat
förväntas; lägg till en bro protokoll versionsfält innan några brytningsändringar.
