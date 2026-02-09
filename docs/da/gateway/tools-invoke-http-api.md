---
summary: "Kald et enkelt værktøj direkte via Gateway HTTP-endpointet"
read_when:
  - Kald af værktøjer uden at køre en fuld agenttur
  - Opbygning af automatiseringer, der kræver håndhævelse af værktøjspolitikker
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw's Gateway udsætter en simpel HTTP endpoint for at påberåbe sig et enkelt værktøj direkte. Det er altid aktiveret, men gated af Gateway auth og værktøjspolitik.

- `POST /tools/invoke`
- Samme port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/tools/invoke`

Standard max nyttelast størrelse er 2 MB.

## Autentificering

Bruger Gateway auth konfiguration. Send et bærer-token:

- `Authorization: Bearer <token>`

Noter:

- Når `gateway.auth.mode="token"`, brug `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- Når `gateway.auth.mode="password"`, brug `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Felter:

- `tool` (string, påkrævet): navnet på det værktøj, der skal kaldes.
- `action` (string, valgfri): mappes ind i args, hvis værktøjsskemaet understøtter `action`, og args-payloaden udelod det.
- `args` (object, valgfri): værktøjsspecifikke argumenter.
- `sessionKey` (streng, valgfri): målsessionsnøgle. Hvis udeladt eller `"main"`, Gateway bruger den konfigurerede hovedsessionsnøgle (honors `session.mainKey` og standard agent eller `global` i globalt omfang).
- `dryRun` (boolean, valgfri): reserveret til fremtidig brug; ignoreres i øjeblikket.

## Politik- og routingadfærd

Tilgængeligheden af værktøjer filtreres gennem den samme politik-kæde, som bruges af Gateway-agenter:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agenter.<id>.tools.allow` / `agenter.<id>.tools.byProvider.allow`
- gruppepolitikker (hvis session-nøglen mapper til en gruppe eller kanal)
- subagent-politik (ved kald med en subagent-session-nøgle)

Hvis et værktøj ikke er tilladt af politikken, returnerer endpointet **404**.

For at hjælpe gruppepolitikker med at løse kontekst kan du valgfrit angive:

- `x-openclaw-message-channel: <channel>` (eksempel: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (når der findes flere konti)

## Svar

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (ugyldig forespørgsel eller værktøjsfejl)
- `401` → ikke autoriseret
- `404` → værktøj ikke tilgængeligt (ikke fundet eller ikke på tilladelseslisten)
- `405` → metode ikke tilladt

## Eksempel

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
