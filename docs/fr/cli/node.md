---
summary: "Reference CLI pour `openclaw node` (hôte de nœud sans interface)"
read_when:
  - Exécution de l’hôte de nœud sans interface
  - Appairage d’un nœud non macOS pour system.run
title: "node"
---

# `openclaw node`

Exécute un **hôte de nœud sans interface** qui se connecte au WebSocket de la Gateway (passerelle) et expose
`system.run` / `system.which` sur cette machine.

## Pourquoi utiliser un hôte de nœud ?

Utilisez un hôte de nœud lorsque vous souhaitez que des agents **exécutent des commandes sur d’autres machines** de votre
réseau sans y installer une application compagnon macOS complète.

Cas d’usage courants :

- Exécuter des commandes sur des machines Linux/Windows distantes (serveurs de build, machines de labo, NAS).
- Conserver l’exécution **en sandbox** sur la gateway, tout en déléguant des exécutions approuvées à d’autres hôtes.
- Fournir une cible d’exécution légère et sans interface pour l’automatisation ou des nœuds CI.

L’exécution reste protégée par des **approbations d’exécution** et des listes d’autorisation par agent sur
l’hôte de nœud, afin de garder un accès aux commandes limité et explicite.

## Proxy navigateur (zéro configuration)

Les hôtes de nœud annoncent automatiquement un proxy navigateur si `browser.enabled` n’est pas
désactivé sur le nœud. Cela permet à l’agent d’utiliser l’automatisation du navigateur sur ce nœud
sans configuration supplémentaire.

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

## Exécuter (premier plan)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Options :

- `--host <host>` : Hôte WebSocket de la Gateway (passerelle) (par défaut : `127.0.0.1`)
- `--port <port>` : Port WebSocket de la Gateway (passerelle) (par défaut : `18789`)
- `--tls` : Utiliser TLS pour la connexion à la gateway
- `--tls-fingerprint <sha256>` : Empreinte de certificat TLS attendue (sha256)
- `--node-id <id>` : Remplacer l’identifiant du nœud (efface le jeton d’appairage)
- `--display-name <name>` : Remplacer le nom d’affichage du nœud

## Service (arrière-plan)

Installe un hôte de nœud sans interface en tant que service utilisateur.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options :

- `--host <host>` : Hôte WebSocket de la Gateway (passerelle) (par défaut : `127.0.0.1`)
- `--port <port>` : Port WebSocket de la Gateway (passerelle) (par défaut : `18789`)
- `--tls` : Utiliser TLS pour la connexion à la gateway
- `--tls-fingerprint <sha256>` : Empreinte de certificat TLS attendue (sha256)
- `--node-id <id>` : Remplacer l’identifiant du nœud (efface le jeton d’appairage)
- `--display-name <name>` : Remplacer le nom d’affichage du nœud
- `--runtime <runtime>` : Environnement d’exécution du service (`node` ou `bun`)
- `--force` : Réinstaller/écraser s’il est déjà installé

Gérer le service :

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Utilisez `openclaw node run` pour un hôte de nœud au premier plan (sans service).

Les commandes de service acceptent `--json` pour une sortie lisible par machine.

## Appairage

La première connexion crée une demande d’appairage de nœud en attente sur la Gateway (passerelle).
Approuvez-la via :

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

L’hôte de nœud stocke son identifiant de nœud, son jeton, son nom d’affichage et les informations de connexion à la gateway dans
`~/.openclaw/node.json`.

## Approbations d’exécution

`system.run` est soumis à des approbations d’exécution locales :

- `~/.openclaw/exec-approvals.json`
- [Approbations d’exécution](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (modifier depuis la Gateway)
