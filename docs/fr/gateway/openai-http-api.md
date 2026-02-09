---
summary: "Exposer un endpoint HTTP /v1/chat/completions compatible OpenAI depuis la Gateway"
read_when:
  - Integration d'outils qui attendent les Chat Completions OpenAI
title: "Chat Completions OpenAI"
---

# Chat Completions OpenAI (HTTP)

La Gateway (passerelle) d’OpenClaw peut servir un petit endpoint Chat Completions compatible OpenAI.

Cet endpoint est **desactive par defaut**. Activez-le d’abord dans la configuration.

- `POST /v1/chat/completions`
- Meme port que la Gateway (multiplexage WS + HTTP) : `http://<gateway-host>:<port>/v1/chat/completions`

En interne, les requetes sont executees comme une execution d’agent Gateway normale (meme chemin de code que `openclaw agent`), de sorte que le routage/les permissions/la configuration correspondent a votre Gateway.

## Authentification

Utilise la configuration d’authentification de la Gateway. Envoyez un jeton bearer :

- `Authorization: Bearer <token>`

Notes :

- Lorsque `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Lorsque `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).

## Choisir un agent

Aucun en-tete personnalise requis : encodez l’id de l’agent dans le champ OpenAI `model` :

- `model: "openclaw:<agentId>"` (exemple : `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Ou ciblez un agent OpenClaw specifique par en-tete :

- `x-openclaw-agent-id: <agentId>` (par defaut : `main`)

Avance :

- `x-openclaw-session-key: <sessionKey>` pour controler completement le routage de session.

## Activation de l’endpoint

Definissez `gateway.http.endpoints.chatCompletions.enabled` sur `true` :

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

## Desactivation de l’endpoint

Definissez `gateway.http.endpoints.chatCompletions.enabled` sur `false` :

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

## Comportement des sessions

Par defaut, l’endpoint est **sans etat par requete** (une nouvelle cle de session est generee a chaque appel).

Si la requete inclut une chaine OpenAI `user`, la Gateway derive une cle de session stable a partir de celle-ci, de sorte que des appels repetes puissent partager une session d’agent.

## Streaming (SSE)

Definissez `stream: true` pour recevoir des Server-Sent Events (SSE) :

- `Content-Type: text/event-stream`
- Chaque ligne d’evenement est `data: <json>`
- Le flux se termine par `data: [DONE]`

## Exemples

Sans streaming :

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

Avec streaming :

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
