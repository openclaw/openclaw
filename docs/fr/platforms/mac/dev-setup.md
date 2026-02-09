---
summary: "Guide de configuration pour les developpeurs travaillant sur l’application macOS OpenClaw"
read_when:
  - Configuration de l’environnement de developpement macOS
title: "Configuration dev macOS"
---

# Configuration developpeur macOS

Ce guide couvre les etapes necessaires pour compiler et executer l’application macOS OpenClaw a partir du code source.

## Prerequis

Avant de compiler l’application, assurez-vous d’avoir installe les elements suivants :

1. **Xcode 26.2+** : Requis pour le developpement Swift.
2. **Node.js 22+ & pnpm** : Requis pour la passerelle, la CLI et les scripts de packaging.

## 1) Installer les dependances

Installez les dependances a l’echelle du projet :

```bash
pnpm install
```

## 2. Compiler et packager l’application

Pour compiler l’application macOS et la packager dans `dist/OpenClaw.app`, executez :

```bash
./scripts/package-mac-app.sh
```

Si vous n’avez pas de certificat Apple Developer ID, le script utilisera automatiquement une **signature ad-hoc** (`-`).

Pour les modes d’execution dev, les options de signature et le depannage du Team ID, consultez le README de l’application macOS :
https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md

> **Note** : Les applications signees en ad-hoc peuvent declencher des invites de securite. Si l’application plante immediatement avec « Abort trap 6 », consultez la section [Depannage](#troubleshooting).

## 3. Installer la CLI

L’application macOS attend une installation globale de la CLI `openclaw` pour gerer les taches en arriere-plan.

**Pour l’installer (recommande) :**

1. Ouvrez l’application OpenClaw.
2. Allez dans l’onglet des parametres **General**.
3. Cliquez sur **« Install CLI »**.

Alternativement, installez-la manuellement :

```bash
npm install -g openclaw@<version>
```

## Problemes courants

### Echec de compilation : incompatibilite de toolchain ou de SDK

La compilation de l’application macOS attend le dernier SDK macOS et la toolchain Swift 6.2.

**Dependances systeme (requises) :**

- **Derniere version de macOS disponible via Mise a jour logicielle** (requise par les SDK Xcode 26.2)
- **Xcode 26.2** (toolchain Swift 6.2)

**Verifications :**

```bash
xcodebuild -version
xcrun swift --version
```

Si les versions ne correspondent pas, mettez a jour macOS/Xcode et relancez la compilation.

### L’application plante lors de l’octroi d’autorisations

Si l’application plante lorsque vous essayez d’autoriser l’acces a la **Reconnaissance vocale** ou au **Microphone**, cela peut etre du a un cache TCC corrompu ou a une incompatibilite de signature.

**Correctif :**

1. Reinitialisez les autorisations TCC :

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. Si cela echoue, modifiez temporairement `BUNDLE_ID` dans [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) afin de forcer une « table rase » cote macOS.

### Gateway (passerelle) bloquee sur « Starting...

Si l’etat de la passerelle reste sur « Starting... », verifiez si un processus zombie occupe le port :

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Si une execution manuelle occupe le port, arretez ce processus (Ctrl+C). En dernier recours, tuez le PID trouve ci-dessus.
