---
summary: "Prise en charge de Linux + statut de l’application compagnon"
read_when:
  - Rechercher le statut de l’application compagnon Linux
  - Planifier la couverture des plateformes ou des contributions
title: "Application Linux"
---

# Application Linux

La Gateway (passerelle) est entièrement prise en charge sous Linux. **Node est le runtime recommandé**.
Bun n’est pas recommandé pour la Gateway (passerelle) (bogues WhatsApp/Telegram).

Des applications compagnon Linux natives sont prévues. Les contributions sont bienvenues si vous souhaitez aider à en construire une.

## Parcours rapide pour debutants (VPS)

1. Installer Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Depuis votre ordinateur portable : `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Ouvrez `http://127.0.0.1:18789/` et collez votre jeton

Guide VPS pas a pas : [exe.dev](/install/exe-dev)

## Installation

- [Premiers pas](/start/getting-started)
- [Installation et mises a jour](/install/updating)
- Flux optionnels : [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Runbook de la Gateway](/gateway)
- [Configuration](/gateway/configuration)

## Installation du service Gateway (passerelle) (CLI)

Utilisez l’une de ces options :

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

Selectionnez **Gateway service** lorsque vous y etes invite.

Reparer/migrer :

```
openclaw doctor
```

## Controle du systeme (unite utilisateur systemd)

OpenClaw installe par defaut un service systemd **utilisateur**. Utilisez un service **systeme**
pour les serveurs partages ou toujours actifs. L’exemple d’unite complet et les recommandations
se trouvent dans le [runbook de la Gateway](/gateway).

Configuration minimale :

Creez `~/.config/systemd/user/openclaw-gateway[-<profile>].service` :

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

Activez-le :

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
