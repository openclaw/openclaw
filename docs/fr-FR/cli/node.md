---
summary: "Référence CLI pour `openclaw node` (hôte de nœud sans tête)"
read_when:
  - Exécution de l'hôte de nœud sans tête
  - Appairage d'un nœud non-macOS pour system.run
title: "node"
---

# `openclaw node`

Exécuter un **hôte de nœud sans tête** qui se connecte au WebSocket de Passerelle et expose `system.run` / `system.which` sur cette machine.

## Pourquoi utiliser un hôte de nœud ?

Utilisez un hôte de nœud quand vous voulez que les agents **exécutent des commandes sur d'autres machines** dans votre réseau sans installer une app compagnon macOS complète là-bas.

Cas d'utilisation courants :

- Exécuter des commandes sur des boxes Linux/Windows distantes (serveurs de build, machines de labo, NAS).
- Garder exec **en sandbox** sur la passerelle, mais déléguer les exécutions approuvées à d'autres hôtes.
- Fournir une cible d'exécution légère et sans tête pour les nœuds d'automatisation ou CI.

L'exécution est toujours gardée par les **approbations exec** et les listes blanches par agent sur l'hôte de nœud, donc vous pouvez garder l'accès aux commandes limité et explicite.

## Proxy de navigateur (zéro-config)

Les hôtes de nœud annoncent automatiquement un proxy de navigateur si `browser.enabled` n'est pas désactivé sur le nœud. Cela permet à l'agent d'utiliser l'automatisation de navigateur sur ce nœud sans configuration supplémentaire.

Désactivez-le sur le nœud si nécessaire :

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Run (avant-plan)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Options :

- `--host <host>` : Hôte WebSocket de Passerelle (par défaut : `127.0.0.1`)
- `--port <port>` : Port WebSocket de Passerelle (par défaut : `18789`)
- `--tls` : Utiliser TLS pour la connexion passerelle
- `--tls-fingerprint <sha256>` : Empreinte de certificat TLS attendue (sha256)
- `--node-id <id>` : Remplacer l'id de nœud (efface le token d'appairage)
- `--display-name <name>` : Remplacer le nom d'affichage du nœud

## Service (arrière-plan)

Installer un hôte de nœud sans tête comme service utilisateur.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options :

- `--host <host>` : Hôte WebSocket de Passerelle (par défaut : `127.0.0.1`)
- `--port <port>` : Port WebSocket de Passerelle (par défaut : `18789`)
- `--tls` : Utiliser TLS pour la connexion passerelle
- `--tls-fingerprint <sha256>` : Empreinte de certificat TLS attendue (sha256)
- `--node-id <id>` : Remplacer l'id de nœud (efface le token d'appairage)
- `--display-name <name>` : Remplacer le nom d'affichage du nœud
- `--runtime <runtime>` : Runtime de service (`node` ou `bun`)
- `--force` : Réinstaller/écraser si déjà installé

Gérer le service :

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Utilisez `openclaw node run` pour un hôte de nœud en avant-plan (pas de service).

Les commandes de service acceptent `--json` pour une sortie lisible par machine.

## Appairage

La première connexion crée une demande d'appairage de nœud en attente sur la Passerelle.
Approuvez-la via :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

L'hôte de nœud stocke son id de nœud, token, nom d'affichage, et infos de connexion passerelle dans `~/.openclaw/node.json`.

## Approbations exec

`system.run` est bloqué par les approbations exec locales :

- `~/.openclaw/exec-approvals.json`
- [Approbations exec](/fr-FR/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (éditer depuis la Passerelle)
