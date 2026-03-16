---
summary: "Installer OpenClaw de manière déclarative avec Nix"
read_when:
  - Vous voulez des installations reproductibles et réversibles
  - Vous utilisez déjà Nix/NixOS/Home Manager
  - Vous voulez tout épinglé et géré de manière déclarative
title: "Nix"
---

# Installation Nix

La façon recommandée d'exécuter OpenClaw avec Nix est via **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — un module Home Manager complet.

## Démarrage rapide

Collez ceci à votre agent IA (Claude, Cursor, etc.) :

```text
Je veux configurer nix-openclaw sur mon Mac.
Dépôt : github:openclaw/nix-openclaw

Ce que je dois faire :
1. Vérifier si Determinate Nix est installé (sinon, l'installer)
2. Créer un flake local dans ~/code/openclaw-local en utilisant templates/agent-first/flake.nix
3. M'aider à créer un bot Telegram (@BotFather) et obtenir mon ID de chat (@userinfobot)
4. Configurer les secrets (jeton bot, clé Anthropic) - fichiers simples dans ~/.secrets/ conviennent
5. Remplir les espaces réservés du modèle et exécuter home-manager switch
6. Vérifier : launchd en cours d'exécution, le bot répond aux messages

Référez-vous au README nix-openclaw pour les options du module.
```

> **📦 Guide complet : [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> Le dépôt nix-openclaw est la source de vérité pour l'installation Nix. Cette page n'est qu'un aperçu rapide.

## Ce que vous obtenez

- Passerelle + application macOS + outils (whisper, spotify, caméras) — tout épinglé
- Service launchd qui survit aux redémarrages
- Système de plugins avec configuration déclarative
- Restauration instantanée : `home-manager switch --rollback`

---

## Comportement d'exécution en mode Nix

Quand `OPENCLAW_NIX_MODE=1` est défini (automatique avec nix-openclaw) :

OpenClaw prend en charge un **mode Nix** qui rend la configuration déterministe et désactive les flux d'auto-installation.
Activez-le en exportant :

```bash
OPENCLAW_NIX_MODE=1
```

Sur macOS, l'application GUI n'hérite pas automatiquement des variables d'environnement du shell. Vous pouvez
aussi activer le mode Nix via defaults :

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Chemins de configuration + état

OpenClaw lit la configuration JSON5 depuis `OPENCLAW_CONFIG_PATH` et stocke les données mutables dans `OPENCLAW_STATE_DIR`.
Si nécessaire, vous pouvez aussi définir `OPENCLAW_HOME` pour contrôler le répertoire home de base utilisé pour la résolution de chemin interne.

- `OPENCLAW_HOME` (précédence par défaut : `HOME` / `USERPROFILE` / `os.homedir()`)
- `OPENCLAW_STATE_DIR` (défaut : `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (défaut : `$OPENCLAW_STATE_DIR/openclaw.json`)

Lors de l'exécution sous Nix, définissez-les explicitement vers des emplacements gérés par Nix afin que l'état d'exécution et la configuration
restent hors du magasin immuable.

### Flux d'auto-installation et bannière en mode Nix

- Les flux d'auto-installation et d'auto-mutation sont désactivés
- Les dépendances manquantes affichent des messages de remédiation spécifiques à Nix
- L'interface affiche une bannière en mode Nix en lecture seule lorsqu'elle est présente

## Note sur le packaging (macOS)

Le flux de packaging macOS s'attend à un modèle Info.plist stable à :

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) copie ce modèle dans le bundle de l'application et corrige les champs dynamiques
(ID de bundle, version/build, SHA Git, clés Sparkle). Cela garde le plist déterministe pour le packaging SwiftPM
et les builds Nix (qui ne dépendent pas d'une chaîne d'outils Xcode complète).

## Connexe

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — guide de configuration complet
- [Assistant](/fr-FR/start/wizard) — configuration CLI non-Nix
- [Docker](/fr-FR/install/docker) — configuration conteneurisée
