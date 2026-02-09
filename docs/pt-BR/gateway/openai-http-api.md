---
summary: "Exponha um endpoint HTTP /v1/chat/completions compatível com OpenAI a partir do Gateway"
read_when:
  - Integração de ferramentas que esperam OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

O Gateway do OpenClaw pode servir um pequeno endpoint de Chat Completions compatível com OpenAI.

Este endpoint é **desativado por padrão**. Ative-o primeiro na configuração.

- `POST /v1/chat/completions`
- Mesma porta do Gateway (multiplexação WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

Por baixo dos panos, as requisições são executadas como uma execução normal de agente do Gateway (mesmo caminho de código que `openclaw agent`), portanto o roteamento/permissões/configuração correspondem ao seu Gateway.

## Autenticação

Usa a configuração de autenticação do Gateway. Envie um token bearer:

- `Authorization: Bearer <token>`

Notas:

- Quando `gateway.auth.mode="token"`, use `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Quando `gateway.auth.mode="password"`, use `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).

## Escolhendo um agente

Nenhum header personalizado é necessário: codifique o id do agente no campo OpenAI `model`:

- `model: "openclaw:<agentId>"` (exemplo: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Ou direcione um agente específico do OpenClaw por header:

- `x-openclaw-agent-id: <agentId>` (padrão: `main`)

Avançado:

- `x-openclaw-session-key: <sessionKey>` para controlar totalmente o roteamento de sessão.

## Ativando o endpoint

Defina `gateway.http.endpoints.chatCompletions.enabled` como `true`:

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

## Desativando o endpoint

Defina `gateway.http.endpoints.chatCompletions.enabled` como `false`:

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

## Comportamento de sessão

Por padrão, o endpoint é **sem estado por requisição** (uma nova chave de sessão é gerada a cada chamada).

Se a requisição incluir uma string OpenAI `user`, o Gateway deriva uma chave de sessão estável a partir dela, para que chamadas repetidas possam compartilhar uma sessão de agente.

## Streaming (SSE)

Defina `stream: true` para receber Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Cada linha de evento é `data: <json>`
- O stream termina com `data: [DONE]`

## Exemplos

Sem streaming:

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

Com streaming:

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
