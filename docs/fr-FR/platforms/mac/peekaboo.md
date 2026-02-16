---
summary: "Intégration PeekabooBridge pour automation UI macOS"
read_when:
  - Hébergement PeekabooBridge dans OpenClaw.app
  - Intégration Peekaboo via Swift Package Manager
  - Changement protocole/chemins PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (automation UI macOS)

OpenClaw peut héberger **PeekabooBridge** comme broker automation UI local, conscient permissions. Cela laisse CLI `peekaboo` conduire automation UI pendant réutilisation permissions TCC app macOS.

## Ce que c'est (et n'est pas)

- **Host** : OpenClaw.app peut agir comme hôte PeekabooBridge.
- **Client** : utilisez CLI `peekaboo` (pas surface `openclaw ui ...` séparée).
- **UI** : overlays visuels restent dans Peekaboo.app ; OpenClaw est hôte broker thin.

## Activer bridge

Dans app macOS :

- Settings → **Enable Peekaboo Bridge**

Quand activé, OpenClaw démarre serveur socket UNIX local. Si désactivé, hôte stoppé et `peekaboo` tombera back vers autres hôtes disponibles.

## Ordre découverte client

Clients Peekaboo essaient typiquement hôtes dans cet ordre :

1. Peekaboo.app (UX complète)
2. Claude.app (si installé)
3. OpenClaw.app (broker thin)

Utilisez `peekaboo bridge status --verbose` pour voir quel hôte actif et quel chemin socket en usage. Vous pouvez override avec :

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Sécurité & Permissions

- Bridge valide **signatures code appelant** ; allowlist TeamIDs enforcée (TeamID hôte Peekaboo + TeamID app OpenClaw).
- Requêtes timeout après ~10 secondes.

## CLI

```bash
peekaboo bridge status
peekaboo bridge status --verbose
```

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Permissions](/fr-FR/platforms/mac/permissions)
- [Compétences](/fr-FR/tools/skills)
