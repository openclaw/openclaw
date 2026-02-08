---
summary: "Eksponér et OpenAI-kompatibelt /v1/chat/completions HTTP-endpoint fra Gateway"
read_when:
  - Integrering af værktøjer, der forventer OpenAI Chat Completions
title: "OpenAI Chat Completions"
x-i18n:
  source_path: gateway/openai-http-api.md
  source_hash: 6f935777f489bff9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:15Z
---

# OpenAI Chat Completions (HTTP)

OpenClaws Gateway kan levere et lille OpenAI-kompatibelt Chat Completions-endpoint.

Dette endpoint er **deaktiveret som standard**. Aktivér det først i konfigurationen.

- `POST /v1/chat/completions`
- Samme port som Gateway (WS + HTTP-multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Under motorhjelmen udføres anmodninger som en normal Gateway agent-kørsel (samme kodevej som `openclaw agent`), så routing/tilladelser/konfiguration matcher din Gateway.

## Autentificering

Bruger Gateway-autentificeringskonfigurationen. Send et bearer-token:

- `Authorization: Bearer <token>`

Noter:

- Når `gateway.auth.mode="token"`, brug `gateway.auth.token` (eller `OPENCLAW_GATEWAY_TOKEN`).
- Når `gateway.auth.mode="password"`, brug `gateway.auth.password` (eller `OPENCLAW_GATEWAY_PASSWORD`).

## Valg af agent

Ingen brugerdefinerede headers kræves: kod agent-id’et i OpenAI-feltet `model`:

- `model: "openclaw:<agentId>"` (eksempel: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Eller målret en specifik OpenClaw-agent via header:

- `x-openclaw-agent-id: <agentId>` (standard: `main`)

Avanceret:

- `x-openclaw-session-key: <sessionKey>` for fuld kontrol over session-routing.

## Aktivering af endpointet

Sæt `gateway.http.endpoints.chatCompletions.enabled` til `true`:

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

## Deaktivering af endpointet

Sæt `gateway.http.endpoints.chatCompletions.enabled` til `false`:

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

## Session-adfærd

Som standard er endpointet **tilstandsløst pr. anmodning** (der genereres en ny sessionsnøgle for hvert kald).

Hvis anmodningen indeholder en OpenAI `user`-streng, udleder Gateway en stabil sessionsnøgle fra den, så gentagne kald kan dele en agent-session.

## Streaming (SSE)

Sæt `stream: true` for at modtage Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Hver eventlinje er `data: <json>`
- Streamen slutter med `data: [DONE]`

## Eksempler

Ikke-streaming:

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
