---
summary: "Ingress webhook pour le réveil et les exécutions d’agents isolées"
read_when:
  - Ajout ou modification des points de terminaison webhook
  - Câblage de systèmes externes dans OpenClaw
title: "Webhooks"
---

# Webhooks

La Gateway (passerelle) peut exposer un petit point de terminaison HTTP de webhook pour des déclencheurs externes.

## Activation

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Remarques :

- `hooks.token` est requis lorsque `hooks.enabled=true`.
- `hooks.path` est défini par défaut sur `/hooks`.

## Authentification

Chaque requête doit inclure le jeton du hook. Préférez les en-têtes :

- `Authorization: Bearer <token>` (recommandé)
- `x-openclaw-token: <token>`
- `?token=<token>` (obsolète ; consigne un avertissement et sera supprimé dans une prochaine version majeure)

## Points de terminaison

### `POST /hooks/wake`

Charge utile :

```json
{ "text": "System line", "mode": "now" }
```

- `text` **obligatoire** (string) : La description de l’événement (p. ex., « New email received »).
- `mode` optionnel (`now` | `next-heartbeat`) : Indique s’il faut déclencher un heartbeat immédiat (par défaut `now`) ou attendre la prochaine vérification périodique.

Effet :

- Met en file d’attente un événement système pour la session **principale**
- Si `mode=now`, déclenche un heartbeat immédiat

### `POST /hooks/agent`

Charge utile :

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **obligatoire** (string) : L’invite ou le message que l’agent doit traiter.
- `name` optionnel (string) : Nom lisible par un humain pour le hook (p. ex., « GitHub »), utilisé comme préfixe dans les résumés de session.
- `sessionKey` optionnel (string) : La clé utilisée pour identifier la session de l’agent. Par défaut, une `hook:<uuid>` aléatoire. L’utilisation d’une clé cohérente permet une conversation multi‑tour dans le contexte du hook.
- `wakeMode` optionnel (`now` | `next-heartbeat`) : Indique s’il faut déclencher un heartbeat immédiat (par défaut `now`) ou attendre la prochaine vérification périodique.
- `deliver` optionnel (boolean) : Si `true`, la réponse de l’agent sera envoyée vers le canal de messagerie. Par défaut `true`. Les réponses qui ne sont que des accusés de réception de heartbeat sont automatiquement ignorées.
- `channel` optionnel (string) : Le canal de messagerie pour la livraison. L’un de : `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Par défaut `last`.
- `to` optionnel (string) : L’identifiant du destinataire pour le canal (p. ex., numéro de téléphone pour WhatsApp/Signal, identifiant de chat pour Telegram, identifiant de canal pour Discord/Slack/Mattermost (plugin), identifiant de conversation pour MS Teams). Par défaut, le dernier destinataire de la session principale.
- `model` optionnel (string) : Remplacement du modèle (p. ex., `anthropic/claude-3-5-sonnet` ou un alias). Doit figurer dans la liste des modèles autorisés si elle est restreinte.
- `thinking` optionnel (string) : Remplacement du niveau de réflexion (p. ex., `low`, `medium`, `high`).
- `timeoutSeconds` optionnel (number) : Durée maximale de l’exécution de l’agent en secondes.

Effet :

- Exécute un tour d’agent **isolé** (clé de session propre)
- Publie toujours un résumé dans la session **principale**
- Si `wakeMode=now`, déclenche un heartbeat immédiat

### `POST /hooks/<name>` (mappé)

Les noms de hooks personnalisés sont résolus via `hooks.mappings` (voir la configuration). Un mappage peut
transformer des charges utiles arbitraires en actions `wake` ou `agent`, avec des modèles optionnels ou
des transformations de code.

Options de mappage (résumé) :

- `hooks.presets: ["gmail"]` active le mappage Gmail intégré.
- `hooks.mappings` vous permet de définir `match`, `action` et des modèles dans la configuration.
- `hooks.transformsDir` + `transform.module` charge un module JS/TS pour une logique personnalisée.
- Utilisez `match.source` pour conserver un point d’ingestion générique (routage piloté par la charge utile).
- Les transformations TS nécessitent un chargeur TS (p. ex., `bun` ou `tsx`) ou des `.js` précompilés à l’exécution.
- Définissez `deliver: true` + `channel`/`to` sur les mappages pour acheminer les réponses vers une surface de discussion
  (`channel` est défini par défaut sur `last` et retombe sur WhatsApp).
- `allowUnsafeExternalContent: true` désactive l’enveloppe de sécurité du contenu externe pour ce hook
  (dangereux ; uniquement pour des sources internes de confiance).
- `openclaw webhooks gmail setup` écrit la configuration `hooks.gmail` pour `openclaw webhooks gmail run`.
  Voir [Gmail Pub/Sub](/automation/gmail-pubsub) pour le flux complet de surveillance Gmail.

## Réponses

- `200` pour `/hooks/wake`
- `202` pour `/hooks/agent` (exécution asynchrone démarrée)
- `401` en cas d’échec d’authentification
- `400` en cas de charge utile invalide
- `413` pour les charges utiles trop volumineuses

## Exemples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Utiliser un modèle différent

Ajoutez `model` à la charge utile de l’agent (ou au mappage) pour remplacer le modèle pour cette exécution :

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Si vous appliquez `agents.defaults.models`, assurez‑vous que le modèle de remplacement y est inclus.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Sécurité

- Conservez les points de terminaison des hooks derrière loopback, un tailnet ou un proxy inverse de confiance.
- Utilisez un jeton de hook dédié ; ne réutilisez pas les jetons d’authentification de la Gateway (passerelle).
- Évitez d’inclure des charges utiles brutes sensibles dans les journaux des webhooks.
- Les charges utiles des hooks sont traitées comme non fiables et enveloppées par des limites de sécurité par défaut.
  Si vous devez désactiver cela pour un hook spécifique, définissez `allowUnsafeExternalContent: true`
  dans le mappage de ce hook (dangereux).
