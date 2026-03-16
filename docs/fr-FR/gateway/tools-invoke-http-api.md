---
summary: "Invoquer un seul outil directement via le point de terminaison HTTP de la Passerelle"
read_when:
  - Appel d'outils sans exécuter un tour d'agent complet
  - Construction d'automatisations nécessitant l'application de politique d'outil
title: "API Invoke d'outils"
---

# Invoke d'outils (HTTP)

La Passerelle d'OpenClaw expose un point de terminaison HTTP simple pour invoquer un seul outil directement. Il est toujours activé, mais contrôlé par l'auth Passerelle et la politique d'outil.

- `POST /tools/invoke`
- Même port que la Passerelle (multiplex WS + HTTP) : `http://<gateway-host>:<port>/tools/invoke`

La taille de charge utile maximale par défaut est de 2 MB.

## Authentification

Utilise la configuration d'auth Passerelle. Envoyez un token bearer :

- `Authorization: Bearer <token>`

Notes :

- Lorsque `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Lorsque `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` est configuré et trop d'échecs d'auth se produisent, le point de terminaison retourne `429` avec `Retry-After`.

## Corps de requête

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Champs :

- `tool` (chaîne, requis) : nom de l'outil à invoquer.
- `action` (chaîne, optionnel) : mappé dans args si le schéma d'outil supporte `action` et que la charge utile args l'a omis.
- `args` (objet, optionnel) : arguments spécifiques à l'outil.
- `sessionKey` (chaîne, optionnel) : clé de session cible. Si omise ou `"main"`, la Passerelle utilise la clé de session principale configurée (honore `session.mainKey` et l'agent par défaut, ou `global` en portée globale).
- `dryRun` (booléen, optionnel) : réservé pour usage futur ; actuellement ignoré.

## Comportement de politique + routage

La disponibilité des outils est filtrée à travers la même chaîne de politique utilisée par les agents Passerelle :

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- politiques de groupe (si la clé de session mappe vers un groupe ou canal)
- politique de sous-agent (lors de l'invocation avec une clé de session de sous-agent)

Si un outil n'est pas autorisé par la politique, le point de terminaison retourne **404**.

HTTP Passerelle applique également une liste de refus dur par défaut (même si la politique de session autorise l'outil) :

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

Vous pouvez personnaliser cette liste de refus via `gateway.tools` :

```json5
{
  gateway: {
    tools: {
      // Outils supplémentaires à bloquer sur HTTP /tools/invoke
      deny: ["browser"],
      // Supprimer des outils de la liste de refus par défaut
      allow: ["gateway"],
    },
  },
}
```

Pour aider les politiques de groupe à résoudre le contexte, vous pouvez optionnellement définir :

- `x-openclaw-message-channel: <channel>` (exemple : `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (quand plusieurs comptes existent)

## Réponses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (requête invalide ou erreur d'entrée d'outil)
- `401` → non autorisé
- `429` → auth limitée en taux (`Retry-After` défini)
- `404` → outil non disponible (non trouvé ou non autorisé)
- `405` → méthode non autorisée
- `500` → `{ ok: false, error: { type, message } }` (erreur d'exécution d'outil inattendue ; message sanitisé)

## Exemple

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
