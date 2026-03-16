---
summary: "Guide setup pour développeurs travaillant sur app macOS OpenClaw"
read_when:
  - Configuration environnement développement macOS
title: "Setup Dev macOS"
---

# Setup Développeur macOS

Ce guide couvre étapes nécessaires pour builder et exécuter application macOS OpenClaw depuis sources.

## Prérequis

Avant builder app, assurez-vous avoir installé :

1. **Xcode 26.2+** : Requis pour développement Swift.
2. **Node.js 22+ & pnpm** : Requis pour passerelle, CLI et scripts packaging.

## 1. Installer Dépendances

Installez dépendances projet-wide :

```bash
pnpm install
```

## 2. Builder et Packager App

Pour builder app macOS et packager dans `dist/OpenClaw.app`, exécutez :

```bash
./scripts/package-mac-app.sh
```

Si vous n'avez pas certificat Apple Developer ID, script utilisera automatiquement **ad-hoc signing** (`-`).

Pour modes run dev, flags signing et troubleshooting Team ID, voir README app macOS :
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Note** : Apps signées ad-hoc peuvent déclencher prompts sécurité. Si app crash immédiatement avec "Abort trap 6", voir section [Dépannage](#dépannage).

## 3. Installer CLI

App macOS attend installation CLI `openclaw` globale pour gérer tâches background.

**Pour l'installer (recommandé) :**

1. Ouvrez app OpenClaw.
2. Allez dans onglet paramètres **Général**.
3. Cliquez **"Install CLI"**.

Alternativement, installez manuellement :

```bash
npm install -g openclaw@<version>
```

## Dépannage

### Build Échoue : Mismatch Toolchain ou SDK

Build app macOS attend dernier SDK macOS et toolchain Swift 6.2.

**Dépendances système (requises) :**

- **Dernière version macOS disponible dans Software Update** (requise par SDKs Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Vérifications :**

```bash
xcodebuild -version
xcrun swift --version
```

Si versions ne correspondent pas, mettez à jour macOS/Xcode et relancez build.

### App Crash lors Permission Grant

Si app crash quand vous essayez autoriser accès **Speech Recognition** ou **Microphone**, peut être dû à cache TCC corrompu ou mismatch signature.

**Fix :**

1. Réinitialisez permissions TCC :

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Si échec, changez temporairement `BUNDLE_ID` dans [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) pour forcer "clean slate" depuis macOS.

### Passerelle "Starting..." indéfiniment

Si statut passerelle reste sur "Starting...", vérifiez si processus zombie tient port :

```bash
openclaw gateway status
openclaw gateway stop

# Si vous n'utilisez pas LaunchAgent (mode dev / runs manuels), trouvez listener :
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Si run manuel tient port, stoppez ce processus (Ctrl+C). En dernier recours, tuez PID trouvé ci-dessus.

Voir aussi :

- [App macOS](/fr-FR/platforms/macos)
- [Lifecycle Passerelle](/fr-FR/platforms/mac/child-process)
- [Permissions](/fr-FR/platforms/mac/permissions)
