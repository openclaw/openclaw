---
summary: "Exposer un point de terminaison HTTP /v1/responses compatible OpenResponses depuis la passerelle"
read_when:
  - Intégration de clients qui communiquent avec l'API OpenResponses
  - Vous voulez des entrées basées sur des items, des appels d'outils côté client ou des événements SSE
title: "API OpenResponses"
---

# API OpenResponses (HTTP)

La passerelle d'OpenClaw peut servir un point de terminaison `POST /v1/responses` compatible avec OpenResponses.

Ce point de terminaison est **désactivé par défaut**. Activez-le d'abord dans la configuration.

- `POST /v1/responses`
- Même port que la passerelle (multiplexage WS + HTTP) : `http://<hôte-passerelle>:<port>/v1/responses`

En coulisses, les requêtes sont exécutées comme une exécution normale d'agent de passerelle (même chemin de code que
`openclaw agent`), donc le routage/permissions/configuration correspondent à votre passerelle.

## Authentification

Utilise la configuration d'authentification de la passerelle. Envoyez un jeton bearer :

- `Authorization: Bearer <jeton>`

Remarques :

- Quand `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Quand `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` est configuré et qu'il y a trop d'échecs d'authentification, le point de terminaison renvoie `429` avec `Retry-After`.

## Choisir un agent

Aucun en-tête personnalisé requis : encodez l'id de l'agent dans le champ `model` d'OpenResponses :

- `model: "openclaw:<agentId>"` (exemple : `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Ou ciblez un agent OpenClaw spécifique par en-tête :

- `x-openclaw-agent-id: <agentId>` (par défaut : `main`)

Avancé :

- `x-openclaw-session-key: <sessionKey>` pour contrôler complètement le routage de session.

## Activation du point de terminaison

Définissez `gateway.http.endpoints.responses.enabled` à `true` :

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Désactivation du point de terminaison

Définissez `gateway.http.endpoints.responses.enabled` à `false` :

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Comportement de session

Par défaut, le point de terminaison est **sans état par requête** (une nouvelle clé de session est générée à chaque appel).

Si la requête inclut une chaîne `user` OpenResponses, la passerelle dérive une clé de session stable
à partir de celle-ci, de sorte que les appels répétés peuvent partager une session d'agent.

## Format de requête (supporté)

La requête suit l'API OpenResponses avec une entrée basée sur des items. Support actuel :

- `input` : chaîne ou tableau d'objets item.
- `instructions` : fusionné dans le prompt système.
- `tools` : définitions d'outils côté client (outils de fonction).
- `tool_choice` : filtrer ou exiger des outils côté client.
- `stream` : active le streaming SSE.
- `max_output_tokens` : limite de sortie au mieux (dépend du fournisseur).
- `user` : routage de session stable.

Accepté mais **actuellement ignoré** :

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (entrée)

### `message`

Rôles : `system`, `developer`, `user`, `assistant`.

- `system` et `developer` sont ajoutés au prompt système.
- L'item `user` ou `function_call_output` le plus récent devient le "message actuel".
- Les messages user/assistant antérieurs sont inclus comme historique pour le contexte.

### `function_call_output` (outils par tour)

Renvoyez les résultats d'outils au modèle :

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` et `item_reference`

Acceptés pour la compatibilité du schéma mais ignorés lors de la construction du prompt.

## Outils (outils de fonction côté client)

Fournissez des outils avec `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Si l'agent décide d'appeler un outil, la réponse renvoie un item de sortie `function_call`.
Vous envoyez ensuite une requête de suivi avec `function_call_output` pour continuer le tour.

## Images (`input_image`)

Supporte les sources base64 ou URL :

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Types MIME autorisés (actuellement) : `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Taille max (actuellement) : 10 Mo.

## Fichiers (`input_file`)

Supporte les sources base64 ou URL :

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Types MIME autorisés (actuellement) : `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Taille max (actuellement) : 5 Mo.

Comportement actuel :

- Le contenu du fichier est décodé et ajouté au **prompt système**, pas au message utilisateur,
  donc il reste éphémère (non persisté dans l'historique de session).
- Les PDF sont analysés pour le texte. Si peu de texte est trouvé, les premières pages sont rastérisées
  en images et passées au modèle.

L'analyse PDF utilise la version legacy `pdfjs-dist` compatible Node (pas de worker). La version
moderne de PDF.js nécessite des workers/globals DOM du navigateur, elle n'est donc pas utilisée dans la passerelle.

Valeurs par défaut pour la récupération d'URL :

- `files.allowUrl` : `true`
- `images.allowUrl` : `true`
- `maxUrlParts` : `8` (total de parties `input_file` + `input_image` basées sur URL par requête)
- Les requêtes sont protégées (résolution DNS, blocage d'IP privée, limites de redirection, timeouts).
- Des listes blanches d'hôtes optionnelles sont supportées par type d'entrée (`files.urlAllowlist`, `images.urlAllowlist`).
  - Hôte exact : `"cdn.example.com"`
  - Sous-domaines wildcard : `"*.assets.example.com"` (ne correspond pas à l'apex)

## Limites de fichiers + images (config)

Les valeurs par défaut peuvent être ajustées sous `gateway.http.endpoints.responses` :

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            urlAllowlist: ["images.example.com"],
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Valeurs par défaut si omises :

- `maxBodyBytes` : 20 Mo
- `maxUrlParts` : 8
- `files.maxBytes` : 5 Mo
- `files.maxChars` : 200k
- `files.maxRedirects` : 3
- `files.timeoutMs` : 10s
- `files.pdf.maxPages` : 4
- `files.pdf.maxPixels` : 4 000 000
- `files.pdf.minTextChars` : 200
- `images.maxBytes` : 10 Mo
- `images.maxRedirects` : 3
- `images.timeoutMs` : 10s

Note de sécurité :

- Les listes blanches d'URL sont appliquées avant la récupération et sur les sauts de redirection.
- Mettre un hôte en liste blanche ne contourne pas le blocage d'IP privée/interne.
- Pour les passerelles exposées sur Internet, appliquez des contrôles de sortie réseau en plus des protections au niveau applicatif.
  Voir [Sécurité](/fr-FR/gateway/security).

## Streaming (SSE)

Définissez `stream: true` pour recevoir des Server-Sent Events (SSE) :

- `Content-Type: text/event-stream`
- Chaque ligne d'événement est `event: <type>` et `data: <json>`
- Le flux se termine par `data: [DONE]`

Types d'événements actuellement émis :

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (en cas d'erreur)

## Utilisation

`usage` est rempli quand le fournisseur sous-jacent rapporte les compteurs de jetons.

## Erreurs

Les erreurs utilisent un objet JSON comme :

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Cas courants :

- `401` authentification manquante/invalide
- `400` corps de requête invalide
- `405` mauvaise méthode

## Exemples

Sans streaming :

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer VOTRE_JETON' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "bonjour"
  }'
```

Avec streaming :

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer VOTRE_JETON' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "bonjour"
  }'
```
