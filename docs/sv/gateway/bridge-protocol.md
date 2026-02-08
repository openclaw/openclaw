---
summary: "Bridge-protokoll (äldre noder): TCP JSONL, parkoppling, avgränsad RPC"
read_when:
  - Bygger eller felsöker nodklienter (iOS/Android/macOS nodläge)
  - Utreder parkopplings- eller bridge‑autentiseringsfel
  - Granskar nodytan som exponeras av gatewayn
title: "Bridge-protokoll"
x-i18n:
  source_path: gateway/bridge-protocol.md
  source_hash: 789bcf3cbc6841fc
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:15Z
---

# Bridge-protokoll (äldre nodtransport)

Bridge-protokollet är en **äldre** nodtransport (TCP JSONL). Nya nodklienter
bör i stället använda det enhetliga Gateway WebSocket-protokollet.

Om du bygger en operatör eller nodklient, använd
[Gateway-protokollet](/gateway/protocol).

**Obs:** Aktuella OpenClaw‑byggen levereras inte längre med TCP‑bridge‑lyssnaren; detta dokument bevaras av historiska skäl.
Äldre `bridge.*`‑konfignycklar ingår inte längre i konfigschemat.

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

Noder kan emitera `exec.finished`‑ eller `exec.denied`‑händelser för att exponera system.run‑aktivitet.
Dessa mappas till systemhändelser i gatewayn. (Äldre noder kan fortfarande emitera `exec.started`.)

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

Bridge är för närvarande **implicit v1** (ingen min/max‑förhandling). Bakåtkompatibilitet
förväntas; lägg till ett versionsfält för bridge‑protokollet före eventuella brytande ändringar.
