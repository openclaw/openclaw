---
summary: "Exposer un point de terminaison HTTP /v1/chat/completions compatible OpenAI depuis la Passerelle"
read_when:
  - Intégration d'outils qui attendent OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

La Passerelle d'OpenClaw peut servir un petit point de terminaison Chat Completions compatible OpenAI.

Ce point de terminaison est **désactivé par défaut**. Activez-le d'abord dans la config.

- `POST /v1/chat/completions`
- Même port que la Passerelle (multiplex WS + HTTP) : `http://<gateway-host>:<port>/v1/chat/completions`

En coulisses, les requêtes sont exécutées comme une exécution d'agent Passerelle normale (même chemin de code que `openclaw agent`), donc le routage/permissions/config correspondent à votre Passerelle.

## Authentification

Utilise la configuration d'auth Passerelle. Envoyez un token bearer :

- `Authorization: Bearer <token>`

Notes :

- Lorsque `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Lorsque `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` est configuré et trop d'échecs d'auth se produisent, le point de terminaison retourne `429` avec `Retry-After`.

## Choisir un agent

Aucun en-tête personnalisé requis : encodez l'id agent dans le champ OpenAI `model` :

- `model: "openclaw:<agentId>"` (exemple : `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Ou ciblez un agent OpenClaw spécifique par en-tête :

- `x-openclaw-agent-id: <agentId>` (défaut : `main`)

Avancé :

- `x-openclaw-session-key: <sessionKey>` pour contrôler totalement le routage de session.

## Activation du point de terminaison

Définissez `gateway.http.endpoints.chatCompletions.enabled` à `true` :

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

## Désactivation du point de terminaison

Définissez `gateway.http.endpoints.chatCompletions.enabled` à `false` :

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

## Comportement de session

Par défaut, le point de terminaison est **sans état par requête** (une nouvelle clé de session est générée à chaque appel).

Si la requête inclut une chaîne OpenAI `user`, la Passerelle dérive une clé de session stable à partir de celle-ci, donc les appels répétés peuvent partager une session agent.

## Streaming (SSE)

Définissez `stream: true` pour recevoir des Server-Sent Events (SSE) :

- `Content-Type: text/event-stream`
- Chaque ligne d'événement est `data: <json>`
- Le flux se termine par `data: [DONE]`

## Exemples

Non-streaming :

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

Streaming :

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
