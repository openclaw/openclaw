---
summary: "Ingression webhook pour réveil et exécutions d'agent isolées"
read_when:
  - Ajouter ou modifier des points de terminaison webhook
  - Câbler des systèmes externes dans OpenClaw
title: "Webhooks"
---

# Webhooks

La Passerelle peut exposer un petit point de terminaison HTTP webhook pour les déclencheurs externes.

## Activer

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    // Optionnel : restreindre le routage `agentId` explicite à cette liste blanche.
    // Omettre ou inclure "*" pour autoriser tout agent.
    // Définir [] pour refuser tout routage `agentId` explicite.
    allowedAgentIds: ["hooks", "main"],
  },
}
```

Notes :

- `hooks.token` est requis quand `hooks.enabled=true`.
- `hooks.path` par défaut est `/hooks`.

## Authentification

Chaque requête doit inclure le token de hook. Préférez les en-têtes :

- `Authorization: Bearer <token>` (recommandé)
- `x-openclaw-token: <token>`
- Les tokens de chaîne de requête sont rejetés (`?token=...` retourne `400`).

## Points de terminaison

### `POST /hooks/wake`

Charge utile :

```json
{ "text": "Ligne système", "mode": "now" }
```

- `text` **requis** (chaîne) : La description de l'événement (ex., "Nouvel e-mail reçu").
- `mode` optionnel (`now` | `next-heartbeat`) : Déclencher un heartbeat immédiat (par défaut `now`) ou attendre la prochaine vérification périodique.

Effet :

- Met en file d'attente un événement système pour la session **principale**
- Si `mode=now`, déclenche un heartbeat immédiat

### `POST /hooks/agent`

Charge utile :

```json
{
  "message": "Exécuter ceci",
  "name": "E-mail",
  "agentId": "hooks",
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

- `message` **requis** (chaîne) : L'invite ou le message que l'agent doit traiter.
- `name` optionnel (chaîne) : Nom lisible par l'homme pour le hook (ex., "GitHub"), utilisé comme préfixe dans les résumés de session.
- `agentId` optionnel (chaîne) : Router ce hook vers un agent spécifique. Les IDs inconnus replient vers l'agent par défaut. Quand défini, le hook s'exécute en utilisant l'espace de travail et la configuration de l'agent résolu.
- `sessionKey` optionnel (chaîne) : La clé utilisée pour identifier la session de l'agent. Par défaut ce champ est rejeté sauf si `hooks.allowRequestSessionKey=true`.
- `wakeMode` optionnel (`now` | `next-heartbeat`) : Déclencher un heartbeat immédiat (par défaut `now`) ou attendre la prochaine vérification périodique.
- `deliver` optionnel (booléen) : Si `true`, la réponse de l'agent sera envoyée au canal de messagerie. Par défaut `true`. Les réponses qui ne sont que des confirmations heartbeat sont automatiquement sautées.
- `channel` optionnel (chaîne) : Le canal de messagerie pour la livraison. Un parmi : `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Par défaut `last`.
- `to` optionnel (chaîne) : L'identifiant de destinataire pour le canal (ex., numéro de téléphone pour WhatsApp/Signal, ID de chat pour Telegram, ID de canal pour Discord/Slack/Mattermost (plugin), ID de conversation pour MS Teams). Par défaut le dernier destinataire dans la session principale.
- `model` optionnel (chaîne) : Remplacement de modèle (ex., `anthropic/claude-3-5-sonnet` ou un alias). Doit être dans la liste de modèles autorisés si restreint.
- `thinking` optionnel (chaîne) : Remplacement de niveau de thinking (ex., `low`, `medium`, `high`).
- `timeoutSeconds` optionnel (nombre) : Durée maximale pour l'exécution de l'agent en secondes.

Effet :

- Exécute un tour d'agent **isolé** (propre clé de session)
- Poste toujours un résumé dans la session **principale**
- Si `wakeMode=now`, déclenche un heartbeat immédiat

## Politique de clé de session (changement cassant)

Les remplacements de `sessionKey` de charge utile `/hooks/agent` sont désactivés par défaut.

- Recommandé : définir un `hooks.defaultSessionKey` fixe et garder les remplacements de requête désactivés.
- Optionnel : autoriser les remplacements de requête uniquement quand nécessaire, et restreindre les préfixes.

Configuration recommandée :

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    defaultSessionKey: "hook:ingress",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
}
```

Configuration de compatibilité (comportement hérité) :

```json5
{
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:"], // fortement recommandé
  },
}
```

### `POST /hooks/<name>` (mappé)

Les noms de hooks personnalisés sont résolus via `hooks.mappings` (voir configuration). Un mapping peut
transformer des charges utiles arbitraires en actions `wake` ou `agent`, avec des templates optionnels ou
des transformations de code.

Options de mapping (résumé) :

- `hooks.presets: ["gmail"]` active le mapping Gmail intégré.
- `hooks.mappings` vous permet de définir `match`, `action`, et templates dans la config.
- `hooks.transformsDir` + `transform.module` charge un module JS/TS pour une logique personnalisée.
  - `hooks.transformsDir` (si défini) doit rester dans la racine de transformations sous votre répertoire de config OpenClaw (typiquement `~/.openclaw/hooks/transforms`).
  - `transform.module` doit se résoudre dans le répertoire de transformations effectif (les chemins de traversée/échappement sont rejetés).
- Utilisez `match.source` pour garder un point de terminaison d'ingestion générique (routage basé sur la charge utile).
- Les transformations TS nécessitent un chargeur TS (ex. `bun` ou `tsx`) ou du `.js` précompilé à l'exécution.
- Définissez `deliver: true` + `channel`/`to` sur les mappings pour router les réponses vers une surface de chat
  (`channel` par défaut est `last` et replie vers WhatsApp).
- `agentId` route le hook vers un agent spécifique ; les IDs inconnus replient vers l'agent par défaut.
- `hooks.allowedAgentIds` restreint le routage `agentId` explicite. Omettez-le (ou incluez `*`) pour autoriser tout agent. Définissez `[]` pour refuser le routage `agentId` explicite.
- `hooks.defaultSessionKey` définit la session par défaut pour les exécutions d'agent de hook quand aucune clé explicite n'est fournie.
- `hooks.allowRequestSessionKey` contrôle si les charges utiles `/hooks/agent` peuvent définir `sessionKey` (par défaut : `false`).
- `hooks.allowedSessionKeyPrefixes` restreint optionnellement les valeurs `sessionKey` explicites des charges utiles de requête et des mappings.
- `allowUnsafeExternalContent: true` désactive l'enveloppe de sécurité de contenu externe pour ce hook
  (dangereux ; uniquement pour les sources internes de confiance).
- `openclaw webhooks gmail setup` écrit la config `hooks.gmail` pour `openclaw webhooks gmail run`.
  Voir [Gmail Pub/Sub](/fr-FR/automation/gmail-pubsub) pour le flux complet de montre Gmail.

## Réponses

- `200` pour `/hooks/wake`
- `202` pour `/hooks/agent` (exécution async démarrée)
- `401` en cas d'échec d'authentification
- `429` après des échecs d'authentification répétés du même client (vérifier `Retry-After`)
- `400` sur charge utile invalide
- `413` sur charges utiles surdimensionnées

## Exemples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"Nouvel e-mail reçu","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Résumer la boîte de réception","name":"E-mail","wakeMode":"next-heartbeat"}'
```

### Utiliser un modèle différent

Ajoutez `model` à la charge utile d'agent (ou au mapping) pour remplacer le modèle pour cette exécution :

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Résumer la boîte de réception","name":"E-mail","model":"openai/gpt-5.2-mini"}'
```

Si vous imposez `agents.defaults.models`, assurez-vous que le modèle de remplacement y est inclus.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Bonjour","snippet":"Salut"}]}'
```

## Sécurité

- Gardez les points de terminaison de hook derrière loopback, tailnet, ou proxy inverse de confiance.
- Utilisez un token de hook dédié ; ne réutilisez pas les tokens d'authentification de passerelle.
- Les échecs d'authentification répétés sont limités en débit par adresse client pour ralentir les tentatives de force brute.
- Si vous utilisez le routage multi-agent, définissez `hooks.allowedAgentIds` pour limiter la sélection `agentId` explicite.
- Gardez `hooks.allowRequestSessionKey=false` sauf si vous avez besoin de sessions sélectionnées par l'appelant.
- Si vous activez la `sessionKey` de requête, restreignez `hooks.allowedSessionKeyPrefixes` (par exemple, `["hook:"]`).
- Évitez d'inclure des charges utiles brutes sensibles dans les journaux webhook.
- Les charges utiles de hook sont traitées comme non fiables et enveloppées avec des limites de sécurité par défaut.
  Si vous devez désactiver cela pour un hook spécifique, définissez `allowUnsafeExternalContent: true`
  dans le mapping de ce hook (dangereux).
