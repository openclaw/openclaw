---
summary: "Support Linux + statut de l'application compagnon"
read_when:
  - Recherche du statut de l'application compagnon Linux
  - Planification de la couverture de plateforme ou contributions
title: "Application Linux"
---

# Application Linux

La Passerelle est entièrement supportée sur Linux. **Node est le runtime recommandé**.
Bun n'est pas recommandé pour la Passerelle (bugs WhatsApp/Telegram).

Les applications compagnons Linux natives sont prévues. Les contributions sont les bienvenues si vous souhaitez aider à en construire une.

## Chemin rapide débutant (VPS)

1. Installer Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Depuis votre laptop : `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Ouvrir `http://127.0.0.1:18789/` et coller votre token

Guide VPS étape par étape : [exe.dev](/fr-FR/install/exe-dev)

## Installation

- [Premiers pas](/fr-FR/start/getting-started)
- [Installation & mises à jour](/fr-FR/install/updating)
- Flux optionnels : [Bun (expérimental)](/fr-FR/install/bun), [Nix](/fr-FR/install/nix), [Docker](/fr-FR/install/docker)

## Passerelle

- [Runbook Passerelle](/fr-FR/gateway)
- [Configuration](/fr-FR/gateway/configuration)

## Installation du service Passerelle (CLI)

Utilisez l'une de ces options :

```
openclaw onboard --install-daemon
```

Ou :

```
openclaw gateway install
```

Ou :

```
openclaw configure
```

Sélectionnez **Service Passerelle** lorsque demandé.

Réparation/migration :

```
openclaw doctor
```

## Contrôle système (unité utilisateur systemd)

OpenClaw installe un service **utilisateur** systemd par défaut. Utilisez un service **système** pour des serveurs partagés ou toujours actifs. L'exemple d'unité complet et les directives se trouvent dans le [Runbook Passerelle](/fr-FR/gateway).

Configuration minimale :

Créer `~/.config/systemd/user/openclaw-gateway[-<profile>].service` :

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

L'activer :

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
