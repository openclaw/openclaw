---
summary: "Reference CLI pour `openclaw browser` (profils, onglets, actions, relais d’extension)"
read_when:
  - Vous utilisez `openclaw browser` et souhaitez des exemples pour les taches courantes
  - Vous voulez controler un navigateur s’executant sur une autre machine via un hote de nœud
  - Vous voulez utiliser le relais de l’extension Chrome (attacher/detacher via le bouton de la barre d’outils)
title: "navigateur"
---

# `openclaw browser`

Gerer le serveur de controle du navigateur d’OpenClaw et executer des actions de navigateur (onglets, instantanes, captures d’ecran, navigation, clics, saisie).

Liens connexes :

- Outil navigateur + API : [Browser tool](/tools/browser)
- Relais d’extension Chrome : [Chrome extension](/tools/chrome-extension)

## Drapeaux courants

- `--url <gatewayWsUrl>` : URL WebSocket de la Gateway (passerelle) (par defaut depuis la configuration).
- `--token <token>` : jeton de la Gateway (passerelle) (si requis).
- `--timeout <ms>` : delai d’expiration de la requete (ms).
- `--browser-profile <name>` : choisir un profil de navigateur (par defaut depuis la configuration).
- `--json` : sortie lisible par machine (le cas echeant).

## Demarrage rapide (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profils

Les profils sont des configurations nommees de routage du navigateur. En pratique :

- `openclaw` : lance/s’attache a une instance Chrome dediee geree par OpenClaw (repertoire de donnees utilisateur isole).
- `chrome` : controle vos onglets Chrome existants via le relais de l’extension Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Utiliser un profil specifique :

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Instantane / capture d’ecran / actions

Snapshot:

```bash
openclaw browser snapshot
```

Capture d’ecran :

```bash
openclaw browser screenshot
```

Navigation/clic/saisie (automatisation de l’UI basee sur des references) :

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Relais de l’extension Chrome (attacher via le bouton de la barre d’outils)

Ce mode permet a l’agent de controler un onglet Chrome existant que vous attachez manuellement (il ne s’attache pas automatiquement).

Installer l’extension decompressee dans un chemin stable :

```bash
openclaw browser extension install
openclaw browser extension path
```

Ensuite Chrome → `chrome://extensions` → activer « Developer mode » → « Load unpacked » → selectionner le dossier affiche.

Guide complet : [Chrome extension](/tools/chrome-extension)

## Controle distant du navigateur (proxy d’hote de nœud)

Si la Gateway (passerelle) s’execute sur une machine differente de celle du navigateur, lancez un **hote de nœud** sur la machine qui dispose de Chrome/Brave/Edge/Chromium. La Gateway (passerelle) transmettra les actions du navigateur a ce nœud (aucun serveur de controle du navigateur distinct n’est requis).

Utilisez `gateway.nodes.browser.mode` pour controler le routage automatique et `gateway.nodes.browser.node` pour epingler un nœud specifique si plusieurs sont connectes.

Securite + configuration a distance : [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
