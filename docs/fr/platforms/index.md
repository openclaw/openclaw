---
summary: "Vue d’ensemble de la prise en charge des plateformes (Gateway + applications compagnon)"
read_when:
  - Recherche de la prise en charge des OS ou des chemins d’installation
  - Choix de l’emplacement d’exécution du Gateway
title: "Plateformes"
---

# Plateformes

Le cœur d’OpenClaw est écrit en TypeScript. **Node est le runtime recommandé**.
Bun n’est pas recommandé pour le Gateway (passerelle) (bugs WhatsApp/Telegram).

Des applications compagnon existent pour macOS (application de barre de menus) et pour les nœuds mobiles (iOS/Android). Des applications compagnon Windows et
Linux sont prévues, mais le Gateway (passerelle) est entièrement pris en charge dès aujourd’hui.
Des applications compagnon natives pour Windows sont également prévues ; le Gateway (passerelle) est recommandé via WSL2.

## Choisir votre OS

- macOS : [macOS](/platforms/macos)
- iOS : [iOS](/platforms/ios)
- Android : [Android](/platforms/android)
- Windows : [Windows](/platforms/windows)
- Linux : [Linux](/platforms/linux)

## VPS & hébergement

- Hub VPS : [VPS hosting](/vps)
- Fly.io : [Fly.io](/install/fly)
- Hetzner (Docker) : [Hetzner](/install/hetzner)
- GCP (Compute Engine) : [GCP](/install/gcp)
- exe.dev (VM + proxy HTTPS) : [exe.dev](/install/exe-dev)

## Liens courants

- Guide d’installation : [Premiers pas](/start/getting-started)
- Runbook du Gateway (passerelle) : [Gateway](/gateway)
- Configuration du Gateway (passerelle) : [Configuration](/gateway/configuration)
- Statut du service : `openclaw gateway status`

## Installation du service Gateway (passerelle) (CLI)

Utilisez l’une de ces options (toutes prises en charge) :

- Assistant (recommandé) : `openclaw onboard --install-daemon`
- Direct : `openclaw gateway install`
- Flux de configuration : `openclaw configure` → sélectionner **Gateway service**
- Réparer/migrer : `openclaw doctor` (propose d’installer ou de corriger le service)

La cible du service dépend de l’OS :

- macOS : LaunchAgent (`bot.molt.gateway` ou `bot.molt.<profile>` ; legacy `com.openclaw.*`)
- Linux/WSL2 : service utilisateur systemd (`openclaw-gateway[-<profile>].service`)
