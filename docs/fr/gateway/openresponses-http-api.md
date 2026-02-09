---
summary: "Exposer un endpoint HTTP /v1/responses compatible OpenResponses depuis la Gateway (passerelle)"
read_when:
  - Integrer des clients qui parlent l’API OpenResponses
  - Vous souhaitez des entrees basees sur des items, des appels d’outils cote client, ou des evenements SSE
title: "API OpenResponses"
---

# API OpenResponses (HTTP)

La Gateway (passerelle) d’OpenClaw peut servir un endpoint `POST /v1/responses` compatible OpenResponses.

Cet endpoint est **desactive par defaut**. Activez-le d’abord dans la configuration.

- `POST /v1/responses`
- Meme port que la Gateway (multiplexage WS + HTTP) : `http://<gateway-host>:<port>/v1/responses`

En interne, les requetes sont executees comme une execution normale d’agent de la Gateway (meme chemin de code que
`openclaw agent`), de sorte que le routage, les autorisations et la configuration correspondent a votre Gateway.

## Authentification

Utilise la configuration d’authentification de la Gateway. Envoyez un jeton bearer :

- `Authorization: Bearer <token>`

Notes :

- Lorsque `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Lorsque `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).

## Choisir un agent

Aucun en-tete personnalise requis : encodez l’id d’agent dans le champ OpenResponses `model` :

- `model: "openclaw:<agentId>"` (exemple : `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Ou ciblez un agent OpenClaw specifique via un en-tete :

- `x-openclaw-agent-id: <agentId>` (defaut : `main`)

Avance :

- `x-openclaw-session-key: <sessionKey>` pour controler entierement le routage de session.

## Activation de l’endpoint

Definissez `gateway.http.endpoints.responses.enabled` sur `true` :

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

## Desactivation de l’endpoint

Definissez `gateway.http.endpoints.responses.enabled` sur `false` :

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

Par defaut, l’endpoint est **sans etat par requete** (une nouvelle cle de session est generee a chaque appel).

Si la requete inclut une chaine OpenResponses `user`, la Gateway derive une cle de session stable
a partir de celle-ci, afin que des appels repetes puissent partager une session d’agent.

## Forme de la requete (prise en charge)

La requete suit l’API OpenResponses avec des entrees basees sur des items. Prise en charge actuelle :

- `input` : chaine ou tableau d’objets item.
- `instructions` : fusionne dans le prompt systeme.
- `tools` : definitions d’outils cote client (outils de fonction).
- `tool_choice` : filtrer ou exiger des outils cote client.
- `stream` : active le streaming SSE.
- `max_output_tokens` : limite de sortie « best-effort » (depend du fournisseur).
- `user` : routage de session stable.

Acceptes mais **actuellement ignores** :

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (entree)

### `message`

Roles : `system`, `developer`, `user`, `assistant`.

- `system` et `developer` sont ajoutes au prompt systeme.
- L’item `user` ou `function_call_output` le plus recent devient le « message courant ».
- Les messages utilisateur/assistant precedents sont inclus comme historique pour le contexte.

### `function_call_output` (outils tour par tour)

Renvoyez les resultats d’outils au modele :

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` et `item_reference`

Acceptes pour compatibilite de schema mais ignores lors de la construction du prompt.

## Outils (outils de fonction cote client)

Fournissez des outils avec `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Si l’agent decide d’appeler un outil, la reponse renvoie un item de sortie `function_call`.
Vous envoyez ensuite une requete de suivi avec `function_call_output` pour poursuivre le tour.

## Images (`input_image`)

Prend en charge des sources base64 ou URL :

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Types MIME autorises (actuel) : `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Taille maximale (actuelle) : 10MB.

## Fichiers (`input_file`)

Prend en charge des sources base64 ou URL :

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

Types MIME autorises (actuel) : `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Taille maximale (actuelle) : 5MB.

Comportement actuel :

- Le contenu des fichiers est decode et ajoute au **prompt systeme**, pas au message utilisateur,
  afin qu’il reste ephemere (non persiste dans l’historique de session).
- Les PDF sont analyses pour le texte. Si peu de texte est trouve, les premieres pages sont rasterisees
  en images et transmises au modele.

L’analyse PDF utilise la build legacy `pdfjs-dist` compatible Node (sans worker). La build moderne
PDF.js attend des workers navigateur/des globales DOM, elle n’est donc pas utilisee dans la Gateway.

Défaut de récupération d'URL :

- `files.allowUrl` : `true`
- `images.allowUrl` : `true`
- Les requetes sont protegees (resolution DNS, blocage des IP privees, plafonds de redirection, delais).

## Limites fichiers + images (config)

Les valeurs par defaut peuvent etre ajusteessous `gateway.http.endpoints.responses` :

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
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

Par défaut en cas d'omission :

- `maxBodyBytes` : 20MB
- `files.maxBytes` : 5MB
- `files.maxChars` : 200k
- `files.maxRedirects` : 3
- `files.timeoutMs` : 10s
- `files.pdf.maxPages` : 4
- `files.pdf.maxPixels` : 4,000,000
- `files.pdf.minTextChars` : 200
- `images.maxBytes` : 10MB
- `images.maxRedirects` : 3
- `images.timeoutMs` : 10s

## Streaming (SSE)

Definissez `stream: true` pour recevoir des Server-Sent Events (SSE) :

- `Content-Type: text/event-stream`
- Chaque ligne d’evenement est `event: <type>` et `data: <json>`
- Le flux se termine par `data: [DONE]`

Types d’evenements actuellement emis :

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (en cas d’erreur)

## Utilisation

`usage` est renseigne lorsque le fournisseur sous-jacent rapporte les comptes de jetons.

## Erreurs

Les erreurs utilisent un objet JSON du type :

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Cas courants :

- `401` authentification manquante/invalide
- `400` corps de requete invalide
- `405` methode incorrecte

## Exemples

Sans streaming :

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Avec streaming :

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
