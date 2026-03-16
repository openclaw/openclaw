---
summary: "Aperçu du support des plateformes (Passerelle + applications compagnons)"
read_when:
  - Recherche de support OS ou chemins d'installation
  - Décision de l'endroit où exécuter la Passerelle
title: "Plateformes"
---

# Plateformes

Le cœur d'OpenClaw est écrit en TypeScript. **Node est le runtime recommandé**.
Bun n'est pas recommandé pour la Passerelle (bugs WhatsApp/Telegram).

Des applications compagnons existent pour macOS (application barre de menu) et nœuds mobiles (iOS/Android). Les applications compagnons Windows et Linux sont prévues, mais la Passerelle est entièrement supportée aujourd'hui.
Les applications compagnons natives pour Windows sont également prévues ; la Passerelle est recommandée via WSL2.

## Choisissez votre OS

- macOS : [macOS](/fr-FR/platforms/macos)
- iOS : [iOS](/fr-FR/platforms/ios)
- Android : [Android](/fr-FR/platforms/android)
- Windows : [Windows](/fr-FR/platforms/windows)
- Linux : [Linux](/fr-FR/platforms/linux)

## VPS & hébergement

- Hub VPS : [Hébergement VPS](/fr-FR/vps)
- Fly.io : [Fly.io](/fr-FR/install/fly)
- Hetzner (Docker) : [Hetzner](/fr-FR/install/hetzner)
- GCP (Compute Engine) : [GCP](/fr-FR/install/gcp)
- exe.dev (VM + proxy HTTPS) : [exe.dev](/fr-FR/install/exe-dev)

## Liens courants

- Guide d'installation : [Premiers pas](/fr-FR/start/getting-started)
- Runbook Passerelle : [Passerelle](/fr-FR/gateway)
- Configuration Passerelle : [Configuration](/fr-FR/gateway/configuration)
- Statut du service : `openclaw gateway status`

## Installation du service Passerelle (CLI)

Utilisez l'une de ces options (toutes supportées) :

- Assistant (recommandé) : `openclaw onboard --install-daemon`
- Direct : `openclaw gateway install`
- Flux de configuration : `openclaw configure` → sélectionnez **Service Passerelle**
- Réparation/migration : `openclaw doctor` (propose d'installer ou de réparer le service)

La cible du service dépend de l'OS :

- macOS : LaunchAgent (`bot.molt.gateway` ou `bot.molt.<profile>` ; legacy `com.openclaw.*`)
- Linux/WSL2 : service utilisateur systemd (`openclaw-gateway[-<profile>].service`)
