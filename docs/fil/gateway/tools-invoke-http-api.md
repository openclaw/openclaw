---
summary: "Tawagin ang isang solong tool nang direkta sa pamamagitan ng Gateway HTTP endpoint"
read_when:
  - Pagtawag ng mga tool nang hindi nagpapatakbo ng buong agent turn
  - Pagbuo ng mga automation na nangangailangan ng pagpapatupad ng tool policy
title: "Tools Invoke API"
x-i18n:
  source_path: gateway/tools-invoke-http-api.md
  source_hash: 17ccfbe0b0d9bb61
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:33Z
---

# Tools Invoke (HTTP)

Inilalantad ng Gateway ng OpenClaw ang isang simpleng HTTP endpoint para sa direktang pagtawag ng isang solong tool. Palagi itong naka-enable, ngunit naka-gate ng Gateway auth at tool policy.

- `POST /tools/invoke`
- Parehong port ng Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`

Ang default na max payload size ay 2 MB.

## Authentication

Gumagamit ng Gateway auth configuration. Magpadala ng bearer token:

- `Authorization: Bearer <token>`

Mga tala:

- Kapag `gateway.auth.mode="token"`, gamitin ang `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Kapag `gateway.auth.mode="password"`, gamitin ang `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

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

Mga field:

- `tool` (string, required): pangalan ng tool na tatawagin.
- `action` (string, optional): ini-map sa args kung sinusuportahan ng tool schema ang `action` at inalis ito sa args payload.
- `args` (object, optional): mga argumentong partikular sa tool.
- `sessionKey` (string, optional): target session key. Kapag inalis o `"main"`, gagamitin ng Gateway ang naka-configure na main session key (iginagalang ang `session.mainKey` at default agent, o `global` sa global scope).
- `dryRun` (boolean, optional): nakareserba para sa hinaharap; kasalukuyang hindi pinapansin.

## Policy + routing behavior

Sinasala ang availability ng tool sa parehong policy chain na ginagamit ng Gateway agents:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- mga group policy (kung ang session key ay naka-map sa isang grupo o channel)
- subagent policy (kapag tumatawag gamit ang subagent session key)

Kung hindi pinapayagan ng policy ang isang tool, magbabalik ang endpoint ng **404**.

Para matulungan ang mga group policy na maresolba ang context, maaari mong opsyonal na itakda ang:

- `x-openclaw-message-channel: <channel>` (halimbawa: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (kapag mayroong maraming account)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (invalid na request o error sa tool)
- `401` → unauthorized
- `404` → tool not available (hindi nahanap o hindi naka-allowlist)
- `405` → method not allowed

## Example

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
