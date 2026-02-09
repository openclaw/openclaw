---
summary: "Roep één enkele tool rechtstreeks aan via het Gateway HTTP-eindpunt"
read_when:
  - Tools aanroepen zonder een volledige agentbeurt te draaien
  - Automatiseringen bouwen die toolbeleidshandhaving vereisen
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

De Gateway van OpenClaw stelt een eenvoudig HTTP-eindpunt beschikbaar om één enkele tool rechtstreeks aan te roepen. Het is altijd ingeschakeld, maar afgeschermd door Gateway-authenticatie en toolbeleid.

- `POST /tools/invoke`
- Zelfde poort als de Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/tools/invoke`

De standaard maximale payloadgrootte is 2 MB.

## Authenticatie

Gebruikt de Gateway-authenticatieconfiguratie. Stuur een bearer-token:

- `Authorization: Bearer <token>`

Notities:

- Wanneer `gateway.auth.mode="token"`, gebruik `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`).
- Wanneer `gateway.auth.mode="password"`, gebruik `gateway.auth.password` (of `OPENCLAW_GATEWAY_PASSWORD`).

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

Velden

- `tool` (string, vereist): naam van de tool die moet worden aangeroepen.
- `action` (string, optioneel): wordt gemapt naar args als het toolschema `action` ondersteunt en de args-payload dit heeft weggelaten.
- `args` (object, optioneel): tool-specifieke argumenten.
- `sessionKey` (string, optioneel): doelsessiesleutel. Indien weggelaten of `"main"`, gebruikt de Gateway de geconfigureerde hoofdsessiesleutel (respecteert `session.mainKey` en de standaardagent, of `global` in globale scope).
- `dryRun` (boolean, optioneel): gereserveerd voor toekomstig gebruik; momenteel genegeerd.

## Beleid + routeringsgedrag

Toolbeschikbaarheid wordt gefilterd via dezelfde beleidsketen die door Gateway-agents wordt gebruikt:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- groepsbeleid (als de sessiesleutel naar een groep of kanaal wijst)
- subagentbeleid (bij aanroepen met een subagentsessiesleutel)

Als een tool niet is toegestaan door het beleid, retourneert het eindpunt **404**.

Om groepsbeleid te helpen context op te lossen, kun je optioneel instellen:

- `x-openclaw-message-channel: <channel>` (voorbeeld: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (wanneer er meerdere accounts bestaan)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (ongeldige aanvraag of toolfout)
- `401` → unauthorized
- `404` → tool niet beschikbaar (niet gevonden of niet op de toegestane lijst)
- `405` → methode niet toegestaan

## Voorbeeld

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
