---
summary: "Référence CLI pour `openclaw browser` (profils, onglets, actions, relais d'extension)"
read_when:
  - Vous utilisez `openclaw browser` et voulez des exemples pour tâches courantes
  - Vous voulez contrôler un navigateur exécuté sur une autre machine via un hôte de nœud
  - Vous voulez utiliser le relais d'extension Chrome (attacher/détacher via bouton de barre d'outils)
title: "browser"
---

# `openclaw browser`

Gérer le serveur de contrôle de navigateur d'OpenClaw et exécuter des actions de navigateur (onglets, snapshots, captures d'écran, navigation, clics, saisie).

Connexe :

- Outil navigateur + API : [Outil navigateur](/fr-FR/tools/browser)
- Relais d'extension Chrome : [Extension Chrome](/fr-FR/tools/chrome-extension)

## Flags courants

- `--url <gatewayWsUrl>` : URL WebSocket de Passerelle (vaut par défaut la config).
- `--token <token>` : Token de Passerelle (si requis).
- `--timeout <ms>` : timeout de requête (ms).
- `--browser-profile <name>` : choisir un profil de navigateur (par défaut depuis config).
- `--json` : sortie lisible par machine (quand supporté).

## Démarrage rapide (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profils

Les profils sont des configs de routage de navigateur nommés. En pratique :

- `openclaw` : lance/s'attache à une instance Chrome dédiée gérée par OpenClaw (répertoire de données utilisateur isolé).
- `chrome` : contrôle vos onglets Chrome existants via le relais d'extension Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Utiliser un profil spécifique :

```bash
openclaw browser --browser-profile work tabs
```

## Onglets

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / capture d'écran / actions

Snapshot :

```bash
openclaw browser snapshot
```

Capture d'écran :

```bash
openclaw browser screenshot
```

Naviguer/cliquer/taper (automatisation UI basée sur ref) :

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "bonjour"
```

## Relais d'extension Chrome (attacher via bouton de barre d'outils)

Ce mode permet à l'agent de contrôler un onglet Chrome existant que vous attachez manuellement (il ne s'attache pas automatiquement).

Installer l'extension décompressée vers un chemin stable :

```bash
openclaw browser extension install
openclaw browser extension path
```

Puis Chrome → `chrome://extensions` → activer "Mode développeur" → "Charger l'extension non empaquetée" → sélectionner le dossier affiché.

Guide complet : [Extension Chrome](/fr-FR/tools/chrome-extension)

## Contrôle de navigateur distant (proxy d'hôte de nœud)

Si la Passerelle s'exécute sur une machine différente du navigateur, exécutez un **hôte de nœud** sur la machine qui a Chrome/Brave/Edge/Chromium. La Passerelle proxiera les actions de navigateur vers ce nœud (pas de serveur de contrôle de navigateur séparé requis).

Utilisez `gateway.nodes.browser.mode` pour contrôler le routage auto et `gateway.nodes.browser.node` pour épingler un nœud spécifique si plusieurs sont connectés.

Sécurité + configuration distante : [Outil navigateur](/fr-FR/tools/browser), [Accès distant](/fr-FR/gateway/remote), [Tailscale](/fr-FR/gateway/tailscale), [Sécurité](/fr-FR/gateway/security)
