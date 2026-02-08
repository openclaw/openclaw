---
summary: "Kald et enkelt værktøj direkte via Gateway HTTP-endpointet"
read_when:
  - Kald af værktøjer uden at køre en fuld agenttur
  - Opbygning af automatiseringer, der kræver håndhævelse af værktøjspolitikker
title: "Tools Invoke API"
x-i18n:
  source_path: gateway/tools-invoke-http-api.md
  source_hash: 17ccfbe0b0d9bb61
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:16Z
---

# Tools Invoke (HTTP)

OpenClaws Gateway eksponerer et simpelt HTTP-endpoint til at kalde et enkelt værktøj direkte. Det er altid aktiveret, men beskyttet af Gateway-autentificering og værktøjspolitik.

- `POST /tools/invoke`
- Samme port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/tools/invoke`

Standard maks. payload-størrelse er 2 MB.

## Autentificering

Bruger Gatewayens autentificeringskonfiguration. Send et bearer-token:

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
- `sessionKey` (string, valgfri): mål-session-nøgle. Hvis den udelades eller er `"main"`, bruger Gateway den konfigurerede primære session-nøgle (respekterer `session.mainKey` og standardagenten, eller `global` i globalt scope).
- `dryRun` (boolean, valgfri): reserveret til fremtidig brug; ignoreres i øjeblikket.

## Politik- og routingadfærd

Tilgængeligheden af værktøjer filtreres gennem den samme politik-kæde, som bruges af Gateway-agenter:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
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
