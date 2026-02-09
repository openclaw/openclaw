---
summary: "Stel een OpenAI-compatibel /v1/chat/completions HTTP-eindpunt bloot via de Gateway"
read_when:
  - Integratie van tools die OpenAI Chat Completions verwachten
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

De Gateway van OpenClaw kan een klein OpenAI-compatibel Chat Completions-eindpunt aanbieden.

Dit eindpunt is **standaard uitgeschakeld**. Schakel het eerst in via de config.

- `POST /v1/chat/completions`
- Dezelfde poort als de Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Onder de motorkap worden verzoeken uitgevoerd als een normale Gateway agent-run (dezelfde codepad als `openclaw agent`), zodat routering/rechten/config overeenkomen met je Gateway.

## Authenticatie

Gebruikt de Gateway-authenticatieconfiguratie. Stuur een bearer-token:

- `Authorization: Bearer <token>`

Notities:

- Wanneer `gateway.auth.mode="token"`, gebruik `gateway.auth.token` (of `OPENCLAW_GATEWAY_TOKEN`).
- Wanneer `gateway.auth.mode="password"`, gebruik `gateway.auth.password` (of `OPENCLAW_GATEWAY_PASSWORD`).

## Een agent kiezen

Geen aangepaste headers vereist: codeer de agent-id in het OpenAI-veld `model`:

- `model: "openclaw:<agentId>"` (voorbeeld: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Of richt je op een specifieke OpenClaw-agent via een header:

- `x-openclaw-agent-id: <agentId>` (standaard: `main`)

Geavanceerd:

- `x-openclaw-session-key: <sessionKey>` om sessieroutering volledig te beheersen.

## Het eindpunt inschakelen

Stel `gateway.http.endpoints.chatCompletions.enabled` in op `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Het eindpunt uitschakelen

Stel `gateway.http.endpoints.chatCompletions.enabled` in op `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Sessiegedrag

Standaard is het eindpunt **stateless per verzoek** (bij elke aanroep wordt een nieuwe sessiesleutel gegenereerd).

Als het verzoek een OpenAI-`user`-string bevat, leidt de Gateway hieruit een stabiele sessiesleutel af, zodat herhaalde aanroepen een agentsessie kunnen delen.

## Streaming (SSE)

Stel `stream: true` in om Server-Sent Events (SSE) te ontvangen:

- `Content-Type: text/event-stream`
- Elke eventregel is `data: <json>`
- De stream eindigt met `data: [DONE]`

## Voorbeelden

Niet-streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
