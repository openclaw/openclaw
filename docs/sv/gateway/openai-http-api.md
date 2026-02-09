---
summary: "Exponera en OpenAI-kompatibel /v1/chat/completions HTTP-ändpunkt från Gateway"
read_when:
  - Integrerar verktyg som förväntar sig OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaws Gateway kan tillhandahålla en liten OpenAI-kompatibel Chat Completions-ändpunkt.

Denna slutpunkt är **inaktiverad som standard**. Aktivera det i konfigurationen först.

- `POST /v1/chat/completions`
- Samma port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Under huven körs förfrågningar som en vanlig Gateway-agentkörning (samma kodväg som `openclaw agent`), så routing/behörigheter/konfiguration matchar din Gateway.

## Autentisering

Använder Gateway auth konfiguration. Skicka en bärare token:

- `Authorization: Bearer <token>`

Noteringar:

- När `gateway.auth.mode="token"`, använd `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- När `gateway.auth.mode="password"`, använd `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Välja en agent

Inga anpassade headers krävs: koda agent-id i OpenAI-fältet `model`:

- `model: "openclaw:<agentId>"` (exempel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Eller rikta in dig på en specifik OpenClaw-agent via header:

- `x-openclaw-agent-id: <agentId>` (standard: `main`)

Avancerat:

- `x-openclaw-session-key: <sessionKey>` för full kontroll över sessionsrouting.

## Aktivera ändpunkten

Sätt `gateway.http.endpoints.chatCompletions.enabled` till `true`:

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

## Inaktivera ändpunkten

Sätt `gateway.http.endpoints.chatCompletions.enabled` till `false`:

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

## Sessionsbeteende

Som standard är ändpunkten **tillståndslös per förfrågan** (en ny sessionsnyckel genereras vid varje anrop).

Om förfrågan inkluderar en OpenAI-sträng `user` härleder Gateway en stabil sessionsnyckel från den, så att upprepade anrop kan dela en agentsession.

## Streaming (SSE)

Sätt `stream: true` för att ta emot Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Varje händelserad är `data: <json>`
- Strömmen avslutas med `data: [DONE]`

## Exempel

Icke-streaming:

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
