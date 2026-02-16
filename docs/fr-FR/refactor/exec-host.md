---
summary: "Plan refactor : routing exec host, approbations node et runner headless"
read_when:
  - Design routing exec host ou approbations exec
  - Implémentation runner node + IPC UI
  - Ajout modes sécurité exec host et commandes slash
title: "Refactor Exec Host"
---

# Plan refactor exec host

## Objectifs

- Ajouter `exec.host` + `exec.security` pour router exécution à travers **sandbox**, **passerelle** et **node**.
- Garder défauts **sûrs** : aucune exécution cross-host sauf si explicitement activée.
- Diviser exécution en **service runner headless** avec UI optionnelle (app macOS) via IPC local.
- Fournir politique **per-agent**, allowlist, mode ask et binding node.
- Supporter **modes ask** qui fonctionnent _avec_ ou _sans_ allowlists.
- Cross-platform : socket Unix + auth token (parité macOS/Linux/Windows).

## Non-objectifs

- Aucune migration allowlist legacy ou support schéma legacy.
- Aucun PTY/streaming pour exec node (output agrégé seulement).
- Aucune nouvelle couche réseau au-delà Bridge + Passerelle existants.

## Décisions (verrouillées)

- **Clés config :** `exec.host` + `exec.security` (override per-agent autorisé).
- **Élévation :** garder `/elevated` comme alias pour accès complet passerelle.
- **Ask défaut :** `on-miss`.
- **Store approbations :** `~/.openclaw/exec-approvals.json` (JSON, aucune migration legacy).
- **Runner :** service système headless ; app UI héberge socket Unix pour approbations.
- **Identité node :** utiliser `nodeId` existant.
- **Auth socket :** socket Unix + token (cross-platform) ; split plus tard si nécessaire.
- **État node host :** `~/.openclaw/node.json` (id node + token pairing).
- **Exec host macOS :** exécuter `system.run` dans app macOS ; service node host forward requêtes via IPC local.
- **Aucun helper XPC :** rester sur socket Unix + token + checks peer.

## Concepts clés

### Host

- `sandbox` : exec Docker (comportement actuel).
- `gateway` : exec sur host passerelle.
- `node` : exec sur runner node via Bridge (`system.run`).

### Mode sécurité

- `deny` : bloquer toujours.
- `allowlist` : autoriser seulement matches.
- `full` : autoriser tout (équivalent elevated).

### Mode ask

- `off` : jamais demander.
- `on-miss` : demander seulement quand allowlist ne correspond pas.
- `always` : demander à chaque fois.

Ask est **indépendant** de allowlist ; allowlist peut être utilisée avec `always` ou `on-miss`.

### Résolution politique (per exec)

1. Résoudre `exec.host` (param tool → override agent → défaut global).
2. Résoudre `exec.security` et `exec.ask` (même précédence).
3. Si host est `sandbox`, procéder avec exec sandbox local.
4. Si host est `gateway` ou `node`, appliquer politique security + ask sur ce host.

## Sécurité défaut

- Défaut `exec.host = sandbox`.
- Défaut `exec.security = deny` pour `gateway` et `node`.
- Défaut `exec.ask = on-miss` (pertinent seulement si security autorise).
- Si aucun binding node défini, **agent peut cibler n'importe quel node**, mais seulement si politique autorise.

## Surface config

### Paramètres tool

- `exec.host` (optionnel) : `sandbox | gateway | node`.
- `exec.nodeId` (optionnel) : ID node cible pour exec node.

### Config agent

```json5
{
  agents: {
    main: {
      exec: {
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
        nodeId: "mac-laptop",
      },
    },
  },
}
```

### Config global

```json5
{
  exec: {
    host: "sandbox",
    security: "deny",
    ask: "on-miss",
  },
}
```

## Flux UI approbations (macOS)

1. Agent appelle tool exec avec `exec.host=node`.
2. Service runner node envoie requête `system.run` via Bridge.
3. App macOS reçoit requête via socket IPC local.
4. App affiche prompt approbation (si mode ask active).
5. User approuve/rejette.
6. App retourne résultat via IPC.
7. Service runner retourne output à agent.

## Surface sécurité

- Socket Unix mode `0600` (owner seulement).
- Token auth + checks peer-UID.
- HMAC challenge/response.
- TTL court requests.

Voir aussi :

- [IPC macOS](/fr-FR/platforms/mac/xpc)
- [Sécurité](/fr-FR/gateway/security)
- [Configuration](/fr-FR/gateway/configuration)
