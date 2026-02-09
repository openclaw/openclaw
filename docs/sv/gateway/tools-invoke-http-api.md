---
summary: "Anropa ett enskilt verktyg direkt via Gateways HTTP-slutpunkt"
read_when:
  - Anropa verktyg utan att köra en fullständig agenttur
  - Bygga automatiseringar som behöver verktygspolicysäkerställande
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaws Gateway exponerar en enkel HTTP-slutpunkt för att åberopa ett enda verktyg direkt. Det är alltid aktiverat, men gated av Gateway auth och verktygspolitik.

- `POST /tools/invoke`
- Samma port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/tools/invoke`

Standardstorlek för max nyttolast är 2 MB.

## Autentisering

Använder Gateway auth konfiguration. Skicka en bärare token:

- `Authorization: Bearer <token>`

Noteringar:

- När `gateway.auth.mode="token"`, använd `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- När `gateway.auth.mode="password"`, använd `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Begärandekropp

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fält:

- `tool` (string, obligatoriskt): namnet på verktyget som ska anropas.
- `action` (string, valfritt): mappas in i args om verktygsschemat stöder `action` och args-nyttolasten utelämnade det.
- `args` (object, valfritt): verktygsspecifika argument.
- `sessionKey` (sträng, valfritt): målsessionsnyckel. Om utelämnad eller `"main"` använder Gateway den konfigurerade huvudsessionsnyckeln (honors `session.mainKey` och standardagent, eller `global` i global omfattning).
- `dryRun` (boolean, valfritt): reserverad för framtida bruk; ignoreras för närvarande.

## Policy- och routningsbeteende

Tillgänglighet för verktyg filtreras genom samma policykedja som används av Gateway-agenter:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agenter.<id>.tools.allow` / `agenter.<id>.tools.byProvider.allow`
- gruppolicyer (om sessionnyckeln mappar till en grupp eller kanal)
- underagentpolicy (vid anrop med en underagents sessionnyckel)

Om ett verktyg inte tillåts av policyn returnerar slutpunkten **404**.

För att hjälpa gruppolicyer att lösa kontext kan du valfritt ange:

- `x-openclaw-message-channel: <channel>` (exempel: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (när flera konton finns)

## Svar

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (ogiltig begäran eller verktygsfel)
- `401` → obehörig
- `404` → verktyg inte tillgängligt (hittades inte eller ej på tillåtelselistan)
- `405` → metod ej tillåten

## Exempel

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
