---
summary: "Intégration de PeekabooBridge pour l’automatisation de l’UI sur macOS"
read_when:
  - Hébergement de PeekabooBridge dans OpenClaw.app
  - Intégration de Peekaboo via Swift Package Manager
  - Modification du protocole/des chemins de PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (automatisation de l’UI macOS)

OpenClaw peut héberger **PeekabooBridge** en tant que courtier local d’automatisation de l’UI, conscient des autorisations. Cela permet à la CLI `peekaboo` de piloter l’automatisation de l’UI tout en réutilisant les autorisations TCC de l’app macOS.

## Ce que c’est (et ce que ce n’est pas)

- **Hôte** : OpenClaw.app peut agir comme hôte PeekabooBridge.
- **Client** : utilisez la CLI `peekaboo` (pas de surface `openclaw ui ...` distincte).
- **UI** : les superpositions visuelles restent dans Peekaboo.app ; OpenClaw est un hôte de courtage léger.

## Activer le bridge

Dans l’app macOS :

- Réglages → **Enable Peekaboo Bridge**

Lorsqu’il est activé, OpenClaw démarre un serveur de socket UNIX local. S’il est désactivé, l’hôte
est arrêté et `peekaboo` se repliera sur d’autres hôtes disponibles.

## Ordre de découverte côté client

Les clients Peekaboo essaient généralement les hôtes dans cet ordre :

1. Peekaboo.app (UX complète)
2. Claude.app (si installé)
3. OpenClaw.app (courtier léger)

Utilisez `peekaboo bridge status --verbose` pour voir quel hôte est actif et quel
chemin de socket est utilisé. Vous pouvez forcer avec :

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Sécurité et autorisations

- Le bridge valide les **signatures de code de l’appelant** ; une liste d’autorisation de TeamIDs est
  appliquée (TeamID de l’hôte Peekaboo + TeamID de l’app OpenClaw).
- Les requêtes expirent après ~10 secondes.
- Si des autorisations requises manquent, le bridge renvoie un message d’erreur clair
  plutôt que de lancer Réglages Système.

## Comportement des instantanés (automatisation)

Les instantanés sont stockés en mémoire et expirent automatiquement après une courte durée.
Si vous avez besoin d’une conservation plus longue, recapturez depuis le client.

## Problemes courants

- Si `peekaboo` indique « bridge client is not authorized », assurez‑vous que le client est
  correctement signé ou exécutez l’hôte avec `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  en mode **debug** uniquement.
- Si aucun hôte n’est trouvé, ouvrez l’une des apps hôtes (Peekaboo.app ou OpenClaw.app)
  et confirmez que les autorisations sont accordées.
