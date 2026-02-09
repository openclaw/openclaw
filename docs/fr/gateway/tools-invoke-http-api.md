---
summary: "Invoquer un seul outil directement via le point de terminaison HTTP de la Gateway (passerelle)"
read_when:
  - Appeler des outils sans exécuter un tour complet d’agent
  - Construire des automatisations nécessitant l’application des politiques d’outils
title: "API d’invocation des outils"
---

# Invocation d’outils (HTTP)

La Gateway (passerelle) d’OpenClaw expose un point de terminaison HTTP simple pour invoquer directement un seul outil. Il est toujours activé, mais protégé par l’authentification de la Gateway et la politique d’outils.

- `POST /tools/invoke`
- Même port que la Gateway (multiplexage WS + HTTP) : `http://<gateway-host>:<port>/tools/invoke`

La taille maximale par défaut de la charge utile est de 2 Mo.

## Authentification

Utilise la configuration d’authentification de la Gateway. Envoyez un jeton bearer :

- `Authorization: Bearer <token>`

Notes :

- Lorsque `gateway.auth.mode="token"`, utilisez `gateway.auth.token` (ou `OPENCLAW_GATEWAY_TOKEN`).
- Lorsque `gateway.auth.mode="password"`, utilisez `gateway.auth.password` (ou `OPENCLAW_GATEWAY_PASSWORD`).

## Corps de la requête

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

- `tool` (string, requis) : nom de l’outil à invoquer.
- `action` (string, optionnel) : mappé dans les args si le schéma de l’outil prend en charge `action` et que la charge utile args l’a omis.
- `args` (object, optionnel) : arguments spécifiques à l’outil.
- `sessionKey` (string, optionnel) : clé de session cible. Si omise ou `"main"`, la Gateway utilise la clé de session principale configurée (respecte `session.mainKey` et l’agent par défaut, ou `global` en portée globale).
- `dryRun` (boolean, optionnel) : réservé à un usage futur ; actuellement ignoré.

## Politique + comportement de routage

La disponibilité des outils est filtrée via la même chaîne de politiques que celle utilisée par les agents de la Gateway :

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- politiques de groupe (si la clé de session correspond à un groupe ou à un canal)
- politique de sous‑agent (lors d’une invocation avec une clé de session de sous‑agent)

Si un outil n’est pas autorisé par la politique, le point de terminaison renvoie **404**.

Pour aider les politiques de groupe à résoudre le contexte, vous pouvez éventuellement définir :

- `x-openclaw-message-channel: <channel>` (exemple : `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (lorsque plusieurs comptes existent)

## Réponses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (requête invalide ou erreur d’outil)
- `401` → non autorisé
- `404` → outil non disponible (introuvable ou non autorisé)
- `405` → méthode non autorisée

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
